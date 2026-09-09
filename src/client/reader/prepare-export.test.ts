import { beforeEach, expect, it, vi } from "vitest";
import { prepareExport } from "./prepare-export";
import { authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";

const io = vi.hoisted(() => ({
  sync: vi.fn(), verify: vi.fn(), restore: vi.fn(), read: vi.fn(), active: vi.fn(), load: vi.fn(), destroy: vi.fn(),
}));
vi.mock("../annotations/sync", () => ({ syncAnnotations: io.sync }));
vi.mock("../annotations/annotation-state", () => ({ readScoreAnnotationState: io.read, restoreOfflineAnnotationSnapshot: io.restore }));
vi.mock("../offline/offline-score-verification", () => ({ findVerifiedOfflineScore: io.verify }));
vi.mock("../platform/local-workspace", async importOriginal => ({ ...await importOriginal<typeof import("../platform/local-workspace")>(), assertLocalWorkspaceActive: io.active }));
vi.mock("./pdf-document", () => ({ loadPdfDocument: io.load }));
const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("reader"), "drive", "score");

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  io.read.mockResolvedValue({ layersReady: true, layers: [] });
  io.load.mockReturnValue({ promise: Promise.resolve({ document: { numPages: 2 } }), destroy: io.destroy });
  io.destroy.mockResolvedValue(undefined);
});

it("prepares an unopened score at its exact PDF version without publishing drafts or saving an offline copy", async () => {
  const task = prepareExport(workspace, "version-2");
  await expect(task.promise).resolves.toMatchObject({ source: { numPages: 2 } });
  expect(io.sync).toHaveBeenCalledWith(workspace, { pull: true, freshLayers: true, push: false });
  expect(io.load).toHaveBeenCalledWith("/api/choirs/drive/scores/score/versions/version-2/pdf", "version-2");
  expect(io.verify).not.toHaveBeenCalled();
  task.destroy(); expect(io.destroy).toHaveBeenCalledOnce();
});

it("does not start PDF loading after the user closes during preparation", async () => {
  let release!: () => void;
  io.sync.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const task = prepareExport(workspace, "v");
  task.destroy(); release();
  await expect(task.promise).rejects.toMatchObject({ name: "AbortError" });
  expect(io.load).not.toHaveBeenCalled();
});

it.each([null, { versionId: "old" }, { versionId: "v", imageManifest: {} }])("refuses missing, stale or image-only offline data", async copy => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  io.verify.mockResolvedValue(copy);
  await expect(prepareExport(workspace, "v").promise).rejects.toThrow("完整 PDF");
  expect(io.load).not.toHaveBeenCalled();
  expect(io.sync).not.toHaveBeenCalled();
});

it("restores verified offline annotation data before offering layer choices", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const bytes = new ArrayBuffer(4);
  const copy = { versionId: "v", blob: { arrayBuffer: async () => bytes } };
  io.verify.mockResolvedValue(copy);
  const task = prepareExport(workspace, "v");
  await task.promise;
  expect(io.restore).toHaveBeenCalledWith(workspace, copy);
  expect(io.load).toHaveBeenCalledWith(bytes, "v");
  expect(io.restore.mock.invocationCallOrder[0]).toBeLessThan(io.read.mock.invocationCallOrder[0]);
  task.destroy();
});

it("rejects revoked workspace authority before loading any PDF", async () => {
  io.active.mockRejectedValue(new Error("owner changed"));
  await expect(prepareExport(workspace, "v").promise).rejects.toThrow("owner changed");
  expect(io.load).not.toHaveBeenCalled();
});
