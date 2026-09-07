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
  expect(fetch).toHaveBeenCalledTimes(1);
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

it("opens server page geometry in image mode without starting PDF.js", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "image-drive", scoreId: "image-score" });
  const manifest = {
    versionId: "image-version", sourceSha256: "a".repeat(64), generation: "11111111-1111-4111-8111-111111111111",
    spec: "png-rgb-v1", engine: "pdfium-149.0.0.0",
    pages: [{ pageNumber: 1, width: 800, height: 600, rotation: 90, crop: [0, 0, 600, 800],
      assets: [2048, 3072].map(edge => ({ edge, width: edge, height: edge * 0.75, sha256: "b".repeat(64), sizeBytes: 100 })) }],
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.endsWith("/images")) return Response.json({ state: "ready", manifest });
    if (input.endsWith("/bootstrap")) return Response.json({ state: "active", permissions: { canManage: false }, score: { id: "image-score", choirId: "image-drive", fileName: "图片.pdf", updatedAt: 1,
      currentVersion: { id: "image-version", versionNumber: 1, sizeBytes: 10, sha256: "a".repeat(64), etag: "test", pageCount: 1, createdAt: 1 } } });
    return new Response(null, { status: 503 });
  }));
  const before = vi.mocked(loadPdfDocument).mock.calls.length;
  const session = new ReaderSession(workspace, null);
  session.recoverDisplay(Object.assign(new Error("decode failure"), { name: "InvalidPDFException" }));
  session.open();
  try {
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe("ready"));
    expect(session.getSnapshot().document?.numPages).toBe(1);
    const page = await session.getSnapshot().document!.getPage(1);
    expect(page.getViewport({ scale: 1 })).toMatchObject({ width: 800, height: 600 });
    expect(vi.mocked(loadPdfDocument).mock.calls.length).toBe(before);
    await vi.waitFor(() => expect(session.getSnapshot().downloading).toBe(false));
    const readable = session.getSnapshot().document;
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(session.retryPdf()).toBe(true);
    expect(session.getSnapshot().document).toBe(readable);
    expect(session.getSnapshot()).toMatchObject({ mode: "images", status: "ready", modeMessage: expect.stringContaining("当前副本仍可使用") });
  } finally { session.dispose(); }
});

it("ignores a late PDF when selecting images before version confirmation", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "late-mode-drive", scoreId: "score" });
  let finish!: (value: Awaited<ReturnType<typeof loadPdfDocument>["promise"]>) => void;
  vi.mocked(loadPdfDocument).mockReturnValueOnce({ promise: new Promise(resolve => { finish = resolve; }), destroy: vi.fn().mockResolvedValue(undefined) });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const session = new ReaderSession(workspace, null);
  session.open();
  try {
    await vi.waitFor(() => expect(finish).toBeDefined());
    session.recoverDisplay(Object.assign(new Error("decode failure"), { name: "InvalidPDFException" }));
    // Only document identity is consumed; PDF.js is the external engine boundary.
    finish({ document: { numPages: 99 } as Awaited<ReturnType<typeof loadPdfDocument>["promise"]>["document"], versionId: "late-version" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(session.getSnapshot()).toMatchObject({ mode: "images", status: "loading", document: null });
  } finally { session.dispose(); }
});

it("keeps automatic recovery temporary across subsequent opens", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "automatic-mode-drive", scoreId: "score" });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const session = new ReaderSession(workspace, null);
  try {
    expect(session.recoverDisplay(Object.assign(new Error("render failure"), { name: "PdfPageRenderError" }))).toBe(true);
    expect(session.getSnapshot().mode).toBe("images");
    const reopened = new ReaderSession(workspace, null);
    expect(reopened.getSnapshot().mode).toBe("pdf");
    session.recoverDisplay(Object.assign(new Error("decode failure"), { name: "InvalidPDFException" }));
    reopened.dispose();
    const explicit = new ReaderSession(workspace, null);
    expect(explicit.getSnapshot().mode).toBe("pdf");
    explicit.dispose();
  } finally { session.dispose(); }
});

it("requires confirmed identity before user-owned offline preparation and cancels it on identity loss", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: "a", choirId: "auth-drive", scoreId: "score" });
  const requested: string[] = [];
  const downloadState: { signal?: AbortSignal | null } = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    requested.push(input);
    if (input.endsWith("/bootstrap")) return Response.json({ state: "active", permissions: { canManage: false }, score: { id: "score", choirId: "auth-drive", fileName: "谱.pdf", updatedAt: 1,
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

it("does not recover transport, permission, timeout or unclassified failures and only tries once", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "classification", scoreId: "score" });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const session = new ReaderSession(workspace, null);
  try {
    for (const error of [new TypeError("Failed to fetch"), Object.assign(new Error(), { status: 403 }), Object.assign(new Error(), { name: "TimeoutError" }), Object.assign(new Error(), { name: "UnknownErrorException", details: "TypeError: Failed to fetch" })]) expect(session.recoverDisplay(error)).toBe(false);
    const failure = Object.assign(new Error(), { name: "InvalidPDFException" });
    expect(session.recoverDisplay(failure)).toBe(true);
    expect(session.recoverDisplay(failure)).toBe(false);
  } finally { session.dispose(); }
});
