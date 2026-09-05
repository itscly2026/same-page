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
  session.selectMode("images");
  session.open();
  try {
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe("ready"));
    expect(session.getSnapshot().document?.numPages).toBe(1);
    const page = await session.getSnapshot().document!.getPage(1);
    expect(page.getViewport({ scale: 1 })).toMatchObject({ width: 800, height: 600 });
    expect(vi.mocked(loadPdfDocument).mock.calls.length).toBe(before);
  } finally { session.dispose(); }
});
