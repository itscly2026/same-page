import { imageManifestSchema } from "../../shared/score-images";
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
    const original = session.getSnapshot().document!;
    session.confirmDisplay(original);
    const offlineModule = await import("../offline/offline-score");
    let completeDownload!: (value: Awaited<ReturnType<typeof offlineModule.prepareOfflineScore>>) => void;
    const prepare = vi.spyOn(offlineModule, "prepareOfflineScore").mockImplementationOnce(() => new Promise(resolve => { completeDownload = resolve; }));
    const download = session.download();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    let rejectPdf!: (reason: Error) => void;
    vi.mocked(loadPdfDocument).mockReturnValueOnce({ promise: new Promise((_resolve, reject) => { rejectPdf = reject; }), destroy: vi.fn().mockResolvedValue(undefined) });
    session.selectMode("pdf");
    expect(session.getSnapshot().document).toBe(original);
    expect(session.getSnapshot().status).toBe("ready");
    // A zoom/page repaint of the retained document must not release rollback.
    session.confirmDisplay(original);
    completeDownload({ ...workspace, key: "verified-image-copy", versionId: "image-version", fileName: "图片.pdf", sha256: "a".repeat(64), pageCount: 1, blob: new Blob(), active: 1, verifiedAt: 1,
      imageManifest: imageManifestSchema.parse(manifest), annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
    await download;
    expect(session.getSnapshot().downloadMessage).toContain("当前显示方式或版本已改变");
    expect(session.getSnapshot().downloadMessage).not.toContain("可以离线打开");
    await vi.waitFor(() => expect(rejectPdf).toBeDefined());
    rejectPdf(new Error("decode failed"));
    await vi.waitFor(() => expect(session.getSnapshot().mode).toBe("images"));
    expect(session.getSnapshot().document).toBe(original);
    expect(session.getSnapshot().modeMessage).toContain("已保留原谱面");
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
    session.selectMode("images");
    // Only document identity is consumed; PDF.js is the external engine boundary.
    finish({ document: { numPages: 99 } as Awaited<ReturnType<typeof loadPdfDocument>["promise"]>["document"], versionId: "late-version" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(session.getSnapshot()).toMatchObject({ mode: "images", status: "loading", document: null });
  } finally { session.dispose(); }
});

it("keeps automatic recovery temporary and persists only an explicit choice", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "automatic-mode-drive", scoreId: "score" });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const session = new ReaderSession(workspace, null);
  try {
    expect(session.recoverDisplay(new Error("render failure"))).toBe(true);
    expect(session.getSnapshot().mode).toBe("images");
    const reopened = new ReaderSession(workspace, null);
    expect(reopened.getSnapshot().mode).toBe("pdf");
    session.selectMode("images");
    reopened.dispose();
    const explicit = new ReaderSession(workspace, null);
    expect(explicit.getSnapshot().mode).toBe("images");
    explicit.dispose();
  } finally { session.dispose(); }
});
