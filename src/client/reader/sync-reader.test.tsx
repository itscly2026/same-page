import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { noCapabilities } from "../../shared/drive-permissions";
import { localDatabase } from "../platform/local-database";
import { authenticatedLocalOwnerKey, activateAuthenticatedLocalOwner, captureLocalWorkspaceSession, createLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";
import { subscribeReaderSync, syncReader } from "./sync-reader";
import { useReaderSession } from "./use-reader-session";
import { clearReaderDocumentCache } from "./reader-document-cache";
vi.mock("./pdf-document", () => ({ loadPdfDocument: vi.fn(() => ({ promise: Promise.resolve({ document: { numPages: 1 }, versionId: "version" }), destroy: async () => undefined })) }));
let workspace: LocalWorkspace;
const layer = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "personal", sharedSlot: null, name: "我的笔记", sortOrder: 0, subscribed: true, subscriptionSource: "personal", displayColor: "#dc2626", colorSource: "personal", adminDefaultColor: null, driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: true };
function response(cursor = 0, hasMore = false, guest = false) {
  return Response.json({ state: "active", score: { id: "score", choirId: "drive", fileName: "谱.pdf", updatedAt: 1,
    currentVersion: { id: "version", versionNumber: 1, sizeBytes: 10, sha256: "a".repeat(64), etag: "version", pageCount: 1, createdAt: 1 } },
    permissions: { capabilities: noCapabilities() }, layers: { layers: guest ? [] : [layer], sharedLayerRevision: 0, permissions: { canManageLayers: false } }, annotations: { cursor, hasMore, objects: [] } });
}
beforeEach(async () => {
  await localDatabase.open(); await activateAuthenticatedLocalOwner("reader");
  workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey("reader"), "drive", "score"));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async () => response()));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearReaderDocumentCache(); });
it("one explicit synchronization uses one combined request and concurrent clicks share it", async () => {
  let release!: () => void;
  vi.mocked(fetch).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return response(); });
  const first = syncReader(workspace), second = syncReader(workspace);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  release(); await Promise.all([first, second]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("/sync?");
});
it("uses the returned cursor and visible layer set for the next page", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(500, true)).mockResolvedValueOnce(response(501));
  await syncReader(workspace);
  const second = new URL(String(vi.mocked(fetch).mock.calls[1][0]), "https://example.test");
  expect(second.searchParams.get("cursor")).toBe("500");
  expect(JSON.parse(second.searchParams.get("layerIds")!)).toEqual([layer.id]);
});
it("does not apply a response from a previous owner session after an identity round trip", async () => {
  let release!: () => void;
  vi.mocked(fetch).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return response(); });
  const pending = syncReader(workspace);
  const rejected = expect(pending).rejects.toThrow();
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  await activateAuthenticatedLocalOwner("other"); await activateAuthenticatedLocalOwner("reader");
  release(); await rejected;
  expect(await localDatabase.annotationLayers.count()).toBe(0);
});
it("detaching one observer does not cancel another reader's explicit sync", async () => {
  let release!: () => void;
  vi.mocked(fetch).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return response(); });
  const controller = new AbortController();
  const first = syncReader(workspace, { signal: controller.signal }), second = syncReader(workspace);
  const rejected = expect(first).rejects.toThrow();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  controller.abort(); await rejected; release(); await second;
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("idle reading, focus, reconnect and rerender never schedule a read", async () => {
  const guest = workspace;
  vi.mocked(fetch).mockImplementation(async () => response());
  const view = renderHook(() => useReaderSession(guest, "reader", "session"));
  await waitFor(() => expect(view.result.current.snapshot.cloudState).toBe("active"));
  await waitFor(() => expect(view.result.current.snapshot.document).not.toBeNull());
  act(() => view.result.current.presentation!.ready(view.result.current.snapshot.document!, 1));
  const requests = vi.mocked(fetch).mock.calls.length;
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  view.rerender();
  expect(fetch).toHaveBeenCalledTimes(requests);
  expect(view.result.current.snapshot.status).toBe("ready");
  view.unmount();
});

it("publishes a manual permission failure to the already-open reader", async () => {
  const listener = vi.fn();
  const unsubscribe = subscribeReaderSync(workspace, listener);
  try {
    await syncReader(workspace);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(syncReader(workspace)).rejects.toThrow("reader_sync_failed");
    expect(listener).toHaveBeenLastCalledWith({ state: "permission-denied" });
  } finally { unsubscribe(); }
});
it("aborts the underlying request when its last reader detaches", async () => {
  let requestSignal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation(async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = syncReader(workspace, { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow();
  await waitFor(() => expect(requestSignal).toBeDefined());
  controller.abort();
  await rejected;
  expect(requestSignal?.aborted).toBe(true);
});
