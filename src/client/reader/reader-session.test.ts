import { noCapabilities } from "../../shared/drive-permissions";
import { beforeEach, expect, it, vi } from "vitest";
import { ReaderSession } from "./reader-session";
import { localDatabase } from "../platform/local-database";
import { resolveLocalWorkspace } from "../platform/local-workspace";
import { loadPdfDocument } from "./pdf-document";
import { clearReaderDocumentCache } from "./reader-document-cache";
import { afterEach } from "vitest";

vi.mock("./pdf-document", () => ({ loadPdfDocument: vi.fn(() => ({ promise: new Promise(() => {}), destroy: vi.fn().mockResolvedValue(undefined) })) }));
beforeEach(async () => { await localDatabase.open(); });
afterEach(() => { clearReaderDocumentCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("disposal makes a delayed cloud result and a late PDF incapable of publishing", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "drive", scoreId: "score" });
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const session = new ReaderSession(workspace, null);
  const observer = vi.fn();
  session.subscribe(observer);
  session.open();
  await vi.waitFor(() => expect(loadPdfDocument).toHaveBeenCalled());
  session.dispose();
  const last = session.getSnapshot();
  const count = observer.mock.calls.length;
  finish(new Response(null, { status: 403 }));
  await Promise.resolve();
  await Promise.resolve();
  expect(session.getSnapshot()).toBe(last);
  expect(observer).toHaveBeenCalledTimes(count);
});

it("repeated foreground refreshes share one pending confirmation", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "drive", scoreId: "score" });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);
  const session = new ReaderSession(workspace, null);
  const first = session.refresh();
  for (let index = 0; index < 20; index++) expect(session.refresh()).toBe(first);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  session.dispose();
});

it("cancelling a stalled open exposes recovery and rejects late results", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "cancel-drive", scoreId: "score" });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const session = new ReaderSession(workspace, null);
  session.open();
  session.cancel();
  expect(session.getSnapshot()).toMatchObject({ status: "error", error: "加载已取消，本机草稿仍然保留。" });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(session.getSnapshot().status).toBe("error");
});

it("a stalled document reaches a recoverable timeout without classifying the device", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "timeout-drive", scoreId: "score" });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.useFakeTimers();
  const session = new ReaderSession(workspace, null);
  try {
    session.open();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(session.getSnapshot()).toMatchObject({ status: "error", error: "加载用时较长，可以重试或返回云盘。这不代表设备不兼容。" });
  } finally { session.dispose(); vi.useRealTimers(); }
});

it("requires confirmed identity before user-owned offline preparation and cancels it on identity loss", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: "a", choirId: "auth-drive", scoreId: "score" });
  const requested: string[] = [];
  const downloadState: { signal?: AbortSignal | null } = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requested.push(input);
    if (input.includes("/sync?")) return Response.json({ state: "active", layers: { layers: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "personal", sharedSlot: null, name: "我的笔记", sortOrder: 0, subscribed: true, subscriptionSource: "personal", displayColor: "#dc2626", colorSource: "personal", adminDefaultColor: null, driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: true }], sharedLayerRevision: 0, permissions: { canManageLayers: false } }, annotations: { cursor: 0, objects: [] }, permissions: { capabilities: noCapabilities() }, score: { id: "score", choirId: "auth-drive", fileName: "谱.pdf", updatedAt: 1,
      currentVersion: { id: "version", versionNumber: 1, sizeBytes: 10, sha256: "a".repeat(64), etag: "test", pageCount: 1, createdAt: 1 } } });
    if (input.endsWith("/pdf") && downloadState.signal !== undefined) {
      downloadState.signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => downloadState.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
    }
    return new Response(null, { status: 503 });
  }));
  const session = new ReaderSession(workspace, null);
  session.open();
  try {
    await vi.waitFor(() => expect(session.getSnapshot().cloudState).toBe("active"));
    await session.download();
    expect(requested.some(url => url.endsWith("/pdf"))).toBe(false);
    session.setAuthenticatedUser("a");
    downloadState.signal = null;
    const download = session.download();
    await vi.waitFor(() => expect(downloadState.signal).toBeInstanceOf(AbortSignal));
    session.setAuthenticatedUser(null);
    await download;
    expect(downloadState.signal).toMatchObject({ aborted: true });
    expect(session.getSnapshot().downloading).toBe(false);
  } finally { session.dispose(); }
});

it.each([
  [Object.assign(new Error(), { name: "PdfEngineUnavailableError" }), "请升级浏览器或系统"],
  [new TypeError("Failed to fetch"), "请检查网络后重试"],
  [Object.assign(new TypeError("Failed to fetch dynamically imported module: https://example.test/pdf.js"), { status: 0 }), "请检查网络后重试"],
  [Object.assign(new Error(), { status: 403 }), "确认登录状态和权限"],
  [Object.assign(new Error(), { name: "InvalidPDFException" }), "PDF 无法解析"],
  [Object.assign(new Error(), { name: "PasswordException" }), "这份 PDF 需要密码"],
])("keeps PDF failure %s actionable without starting another rendering service", async (error, message) => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "failure-drive", scoreId: "score" });
  vi.mocked(loadPdfDocument).mockImplementationOnce(() => ({ promise: Promise.reject(error), destroy: vi.fn().mockResolvedValue(undefined) }));
  const fetchMock = vi.fn(async (input: string) => input.includes("/sync?")
    ? Response.json({ state: "active", layers: { layers: [], sharedLayerRevision: 0, permissions: { canManageLayers: false } }, annotations: { cursor: 0, objects: [] }, permissions: { capabilities: noCapabilities() }, score: { id: "score", choirId: "failure-drive", fileName: "谱.pdf", updatedAt: 1,
      currentVersion: { id: "version", versionNumber: 1, sizeBytes: 10, sha256: "a".repeat(64), etag: "test", pageCount: 1, createdAt: 1 } } })
    : new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  const session = new ReaderSession(workspace, null);
  session.open();
  try {
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe("error"));
    expect(session.getSnapshot().error).toContain(message);
    expect(session.getSnapshot().document).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([expect.stringContaining("/sync?")]));
    expect(fetchMock.mock.calls.map(([url]) => url).filter(url => !/\/(sync|layers|annotations)(\?|$)/.test(url))).toEqual([]);
  } finally { session.dispose(); }
});

it("a hidden open retains its foreground deadline and still times out when visibly stalled", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "hidden-timeout-drive", scoreId: "score" });
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ state: "active", layers: { layers: [], sharedLayerRevision: 0, permissions: { canManageLayers: false } }, annotations: { cursor: 0, objects: [] }, permissions: { capabilities: noCapabilities() }, score: { id: "score", choirId: "hidden-timeout-drive", fileName: "test.pdf", updatedAt: 1,
    currentVersion: { id: "version", versionNumber: 1, sizeBytes: 10, sha256: "a".repeat(64), etag: "test", pageCount: 1, createdAt: 1 } } })));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.useFakeTimers();
  const session = new ReaderSession(workspace, null);
  try {
    session.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.getSnapshot().status).toBe("loading");
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(44_999);
    expect(session.getSnapshot()).toMatchObject({status: "loading", error: null});
    await vi.advanceTimersByTimeAsync(1);
    expect(session.getSnapshot().status).toBe("error");
  } finally { session.dispose(); vi.useRealTimers(); }
});
