import { storeOfflineScore } from "../platform/local-database";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { queueScoreDrafts, cacheAnnotationLayers, readAnnotationLayers, readScoreAnnotationState, restoreOfflineAnnotationSnapshot, saveAnnotationDraft } from "./annotation-state";
import { pushPendingAnnotations, getAnnotationSyncActivity, syncAnnotations, withScoreSyncLock } from "./sync";
import { captureOfflineAnnotationSnapshot } from "./offline-snapshot";
import { findVerifiedOfflineScore, sha256Hex, verifyOfflineScore } from "../offline/offline-score-verification";
import { activateVerifiedOfflineScore, localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, captureLocalWorkspaceSession, authenticatedLocalOwnerKey, createLocalWorkspace, resolveLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";

let workspace: LocalWorkspace;
const own: AnnotationLayerSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "personal", sharedSlot: null,
  name: "我的笔记", sortOrder: 10000, subscribed: true, subscriptionSource: "personal",
  displayColor: "#b4235a", colorSource: "personal", adminDefaultColor: null,
  driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null,
  canEdit: true, sharing: false, canShare: true,
};
const published: AnnotationLayerSummary = { ...own, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "声部长的笔记", canEdit: false, sharing: true, canShare: false, subscribed: false };
let serverLayers: AnnotationLayerSummary[];
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
const emptyPull = () => Response.json({ cursor: 0, objects: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.stubGlobal("Blob", NodeBlob);
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  await localDatabase.open();
  await activateAuthenticatedLocalOwner("reader");
  workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey("reader"), "drive", "score"));
  serverLayers = [{ ...own }, { ...published }];
  await cacheAnnotationLayers(workspace, serverLayers);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/layers")
    ? Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } }) : emptyPull()));
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
});

it("loads older notes on a newly shared layer and removes revoked notes from offline restoration", async () => {
  serverLayers = [{ ...own }];
  const cursors: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/layers")) return Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    const cursor = Number(new URL(url, "https://example.test").searchParams.get("cursor")); cursors.push(cursor);
    return Response.json({ cursor: 100, objects: serverLayers.length > 1 && cursor === 0 ? [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", layerId: published.id, version: 1, deleted: false,
      payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "早先写下的笔记" },
      createdByDisplayName: "", updatedByDisplayName: "", updatedAt: 1,
    }] : [] });
  }));
  await syncAnnotations(workspace, { pull: true });
  await syncAnnotations(workspace, { pull: true });
  serverLayers.push({ ...published });
  await syncAnnotations(workspace, { pull: true });
  expect(cursors).toEqual([0, 100, 0]);
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([expect.objectContaining({ layerId: published.id })]);
  const staleRecord: OfflineScoreRecord = {
    ...workspace, key: "offline-test", versionId: "version", fileName: "谱.pdf", sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  expect(await verifyOfflineScore(staleRecord)).toBe(true);
  await storeOfflineScore(staleRecord);
  serverLayers = [{ ...own }];
  await syncAnnotations(workspace, { pull: true });
  expect(await findVerifiedOfflineScore(workspace)).not.toBeNull();
  await restoreOfflineAnnotationSnapshot(workspace, staleRecord);
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([]);
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === published.id)).toBe(false);
});


it("rejects an older sibling-score response after a drive-wide revocation", async () => {
  const sibling = await captureLocalWorkspaceSession(createLocalWorkspace(workspace.ownerKey, workspace.choirId, "sibling"));
  const shared: AnnotationLayerSummary = { ...own, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "shared", sharedSlot: "E", name: "Ensemble" };
  await cacheAnnotationLayers(workspace, [own, shared], 1);
  await cacheAnnotationLayers(sibling, [own, shared], 1);
  const staleSnapshot: OfflineScoreRecord = {
    ...sibling, key: "sibling-offline", versionId: "version", fileName: "谱.pdf", sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(sibling),
  };
  await storeOfflineScore(staleSnapshot);
  const response = deferred<Response>();
  let siblingStarted = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/sibling/")) { siblingStarted = true; return response.promise; }
    return Response.json({ layers: [own], sharedLayerRevision: 2, permissions: { canManageLayers: false } });
  }));
  const staleRefresh = syncAnnotations(sibling, { pull: true });
  const rejected = expect(staleRefresh).rejects.toThrow("shared_layer_state_changed");
  await vi.waitFor(() => expect(siblingStarted).toBe(true));
  await pushPendingAnnotations(workspace, { maxOperations: 100 });
  response.resolve(Response.json({ layers: [own, shared], sharedLayerRevision: 1, permissions: { canManageLayers: false } }));
  await rejected;
  await restoreOfflineAnnotationSnapshot(sibling, staleSnapshot);
  expect((await readAnnotationLayers(sibling)).map(layer => layer.id)).toEqual([own.id]);
  expect((await localDatabase.offlineSnapshots.get(staleSnapshot.key))?.annotationSnapshot.layers.map(layer => layer.id)).toEqual([own.id]);
  expect(await findVerifiedOfflineScore(sibling)).not.toBeNull();
});

it("checks layer status before reconnect uploads, keeps deleted-layer drafts and conflicts, and resumes only the original identity", async () => {
  const shared: AnnotationLayerSummary = { ...own, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "shared", sharedSlot: "piano", name: "钢琴" };
  serverLayers = [own, shared];
  await cacheAnnotationLayers(workspace, serverLayers);
  const draftId = crypto.randomUUID();
  const personalId = crypto.randomUUID();
  const draft = { kind: "text" as const, pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "断网时保存的提示" };
  await saveAnnotationDraft(workspace, { id: draftId, layerId: shared.id, payload: draft });
  await saveAnnotationDraft(workspace, { id: personalId, layerId: own.id, payload: draft });
  await queueScoreDrafts(workspace);
  const oldOperation = (await localDatabase.annotationOutbox.toArray()).find(op => op.annotationId === draftId)!;
  await localDatabase.annotationConflicts.put({ ...workspace, opId: "other-conflict", annotationId: crypto.randomUUID(), layerId: shared.id, localPayload: draft, localDeleted: false, canonical: null, createdAt: 1 });
  const snapshot: OfflineScoreRecord = {
    ...workspace, key: "deleted-layer-offline", versionId: "version", fileName: "谱.pdf", sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  await storeOfflineScore(snapshot);
  serverLayers = [own];
  const requests: string[] = [];
  const uploaded: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(String(input));
    if (String(input).endsWith("/layers")) return Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    const body = JSON.parse(String(init?.body)) as { operations: { opId: string; annotationId: string; layerId: string; payload: typeof draft }[] };
    return Response.json({ results: body.operations.map(op => {
      uploaded.push(op.layerId);
      return { opId: op.opId, status: "accepted", object: { id: op.annotationId, layerId: op.layerId, version: 1, deleted: false, payload: op.payload, createdByDisplayName: "我", updatedByDisplayName: "我", updatedAt: 1 } };
    }) });
  }));
  expect(await pushPendingAnnotations(workspace, { maxOperations: 100 })).toBe(1);
  expect(requests[0]).toMatch(/\/layers$/);
  expect(uploaded).toEqual([own.id]);
  expect(await localDatabase.annotationOutbox.get(oldOperation.opId)).toMatchObject({ attemptedAt: null, layerId: shared.id });
  expect(await localDatabase.annotationConflicts.get("other-conflict")).toMatchObject({ localPayload: draft });
  expect(await findVerifiedOfflineScore(workspace)).not.toBeNull();
  await restoreOfflineAnnotationSnapshot(workspace, snapshot);
  expect((await readAnnotationLayers(workspace)).map(layer => layer.id)).toEqual([own.id]);
  // Expiry followed by a new identically named slot cannot adopt old work.
  serverLayers.push({ ...shared, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sharedSlot: "new-piano" });
  expect(await pushPendingAnnotations(workspace, { maxOperations: 100 })).toBe(0);
  expect(await localDatabase.annotationOutbox.get(oldOperation.opId)).toBeDefined();
  serverLayers = [own, shared];
  expect(await pushPendingAnnotations(workspace, { maxOperations: 100 })).toBe(1);
  expect(uploaded).toEqual([own.id, shared.id]);
  expect(await localDatabase.annotationOutbox.get(oldOperation.opId)).toBeUndefined();
  expect(await localDatabase.annotationConflicts.get("other-conflict")).toBeDefined();
});

it("keeps paused shared notes but does not restore their layer from an older offline snapshot", async () => {
  const shared: AnnotationLayerSummary = { ...own, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "shared", sharedSlot: "piano", name: "钢琴", sharing: undefined, canShare: undefined };
  serverLayers = [{ ...own }, shared];
  await cacheAnnotationLayers(workspace, serverLayers);
  await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: shared.id,
    payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "保留的伴奏笔记" } });
  const staleRecord: OfflineScoreRecord = {
    ...workspace, key: "paused-offline-test", versionId: "version", fileName: "谱.pdf", sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  expect(await verifyOfflineScore(staleRecord)).toBe(true);
  await storeOfflineScore(staleRecord);
  serverLayers = [{ ...own }];
  await syncAnnotations(workspace, { pull: true });
  expect(await findVerifiedOfflineScore(workspace)).not.toBeNull();
  await restoreOfflineAnnotationSnapshot(workspace, staleRecord);
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === shared.id)).toBe(false);
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([expect.objectContaining({ layerId: shared.id })]);
  serverLayers.push(shared);
  await syncAnnotations(workspace, { pull: true });
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === shared.id)).toBe(true);
});


it("does not activate a captured publication after a sync withdraws it during file verification", async () => {
  const candidate: OfflineScoreRecord = {
    ...workspace, key: "inflight-copy", versionId: "version", fileName: "谱.pdf",
    sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1,
    annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  expect(candidate.annotationSnapshot.layers.some(layer => layer.id === published.id)).toBe(true);
  expect(await verifyOfflineScore(candidate)).toBe(true);
  serverLayers = [{ ...own }];
  await syncAnnotations(workspace, { pull: true });
  await activateVerifiedOfflineScore(candidate, { activeKey: null });
  const activated = await findVerifiedOfflineScore(workspace);
  expect(activated).not.toBeNull();
  expect(activated!.annotationSnapshot.layers.some(layer => layer.id === published.id)).toBe(false);
  await restoreOfflineAnnotationSnapshot(workspace, candidate);
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === published.id)).toBe(false);
});

it.each(["Web Locks", "lease"])("shares a refresh under %s and detaches only the cancelling reader", async kind => {
  let acquisitions = 0;
  if (kind === "Web Locks") Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (_name: string, _options: LockOptions, action: (lock: object) => Promise<unknown>) => {
      acquisitions++;
      return action({});
    },
  } });
  const gate = deferred<Response>();
  let layerRequests = 0;
  let pullSignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/layers")) {
      layerRequests++;
      return Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    }
    pullSignal = init?.signal;
    return gate.promise;
  }));
  const controller = new AbortController();
  const firstLayers = vi.fn();
  const first = syncAnnotations(workspace, { pull: true, signal: controller.signal, onLayersApplied: firstLayers });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(pullSignal).toBeDefined());
  expect(firstLayers).toHaveBeenCalledOnce();
  const secondLayers = vi.fn();
  const second = syncAnnotations(workspace, { pull: true, freshLayers: false, onLayersApplied: secondLayers });
  await vi.waitFor(() => expect(secondLayers).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(pullSignal?.aborted).toBe(false);
  gate.resolve(emptyPull());
  await expect(second).resolves.toEqual({ pushed: 0, pulled: 0 });
  expect(firstLayers).toHaveBeenCalledOnce();
  expect(layerRequests).toBe(1);
  if (kind === "Web Locks") expect(acquisitions).toBe(1);
  else expect(await localDatabase.syncLeases.count()).toBe(0);
});

it("queues fresh access after an earlier request and shares the queued refresh", async () => {
  const gate = deferred<Response>();
  let layerRequests = 0;
  const oldLayers = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/layers")) {
      layerRequests++;
      return Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    }
    return layerRequests === 1 ? gate.promise : emptyPull();
  }));
  const reader = syncAnnotations(workspace, { pull: true, onLayersApplied: oldLayers });
  await vi.waitFor(() => expect(oldLayers).toHaveBeenCalledOnce());
  serverLayers = [{ ...own }];
  const fresh = vi.fn();
  const offline = syncAnnotations(workspace, { pull: true, onLayersApplied: fresh });
  const manual = syncAnnotations(workspace, { pull: true });
  expect(fresh).not.toHaveBeenCalled();
  gate.resolve(emptyPull());
  await Promise.all([reader, offline, manual]);
  expect(layerRequests).toBe(2);
  expect(fresh).toHaveBeenCalledWith([own]);
  expect(await readAnnotationLayers(workspace)).toEqual([expect.objectContaining(own)]);
});

it("cancels an unneeded transport without blocking a new caller or applying its late response", async () => {
  const gate = deferred<Response>();
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith("/layers")) return emptyPull();
    requests++;
    return requests === 1 ? gate.promise : Response.json({ layers: [own], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
  }));
  const controller = new AbortController();
  const notified = vi.fn();
  const cancelled = syncAnnotations(workspace, { pull: true, signal: controller.signal, onLayersApplied: notified });
  const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(requests).toBe(1));
  controller.abort();
  await rejected;
  await syncAnnotations(workspace, { pull: true, freshLayers: false });
  gate.resolve(Response.json({ layers: [own, published], sharedLayerRevision: 0, permissions: { canManageLayers: false } }));
  expect(notified).not.toHaveBeenCalled();
  expect(await readAnnotationLayers(workspace)).toEqual([expect.objectContaining(own)]);
});

it("never shares an old epoch after A to B to A, even while its response is pending", async () => {
  const gate = deferred<Response>();
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith("/layers")) return emptyPull();
    requests++;
    return requests === 1 ? gate.promise : Response.json({ layers: [own], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
  }));
  const notified = vi.fn();
  const first = syncAnnotations(workspace, { pull: true, onLayersApplied: notified });
  const rejected = expect(first).rejects.toThrow("local_workspace_owner_changed");
  await vi.waitFor(() => expect(requests).toBe(1));
  await activateAuthenticatedLocalOwner("other");
  await activateAuthenticatedLocalOwner("reader");
  const current = await captureLocalWorkspaceSession(createLocalWorkspace(workspace.ownerKey, "drive", "score"));
  await syncAnnotations(current, { pull: true, freshLayers: false });
  await rejected;
  gate.resolve(Response.json({ layers: [own, published], sharedLayerRevision: 0, permissions: { canManageLayers: false } }));
  expect(requests).toBe(2);
  expect(notified).not.toHaveBeenCalled();
  expect(await readAnnotationLayers(current)).toEqual([expect.objectContaining(own)]);
  expect(await localDatabase.syncLeases.count()).toBe(0);
});

it.each([0, 1])("keeps committed revocations and local drafts when content page %i fails", async failingPage => {
  const draftId = crypto.randomUUID();
  await saveAnnotationDraft(workspace, { id: draftId, layerId: own.id,
    payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "本机草稿" } });
  await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: published.id,
    payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "分享内容" } });
  let page = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/layers")) return Response.json({ layers: [own], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    return page++ === failingPage ? new Response(null, { status: 503 }) : Response.json({ cursor: 1, hasMore: true, objects: [] });
  }));
  const applied = vi.fn();
  await expect(syncAnnotations(workspace, { pull: true, onLayersApplied: applied })).rejects.toThrow("annotation_pull_failed");
  expect(applied).toHaveBeenCalledWith([own]);
  expect(await readAnnotationLayers(workspace)).toEqual([expect.objectContaining(own)]);
  const state = await readScoreAnnotationState(workspace);
  expect(state.annotations).toEqual([expect.objectContaining({ id: draftId, state: "draft" })]);
});

it.each([401, 403, 404, 503, "network", "identity"])("handles layer refresh failure %s without erasing own drafts", async failure => {
  const draftId = crypto.randomUUID();
  await saveAnnotationDraft(workspace, { id: draftId, layerId: own.id,
    payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "我的草稿" } });
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (failure === "network") throw new TypeError("offline");
    if (failure === "identity") return Response.json({ layers: [], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    return new Response(null, { status: Number(failure) });
  }));
  await expect(syncAnnotations(workspace, { pull: true })).rejects.toThrow();
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === published.id)).toBe(failure === 503 || failure === "network");
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([expect.objectContaining({ id: draftId, state: "draft" })]);
});

it("retains guest subscriptions but applies authenticated subscriptions from the server", async () => {
  const shared: AnnotationLayerSummary = { ...own, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "shared", sharedSlot: "piano", sharing: undefined, canShare: undefined, subscribed: true, canEdit: false };
  await cacheAnnotationLayers(workspace, [own, { ...shared, subscribed: false }]);
  serverLayers = [own, shared];
  await syncAnnotations(workspace, { pull: true });
  expect((await readAnnotationLayers(workspace)).find(layer => layer.id === shared.id)?.subscribed).toBe(true);
  await localDatabase.system.clear();
  const guest = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "drive", scoreId: "score" });
  await cacheAnnotationLayers(guest, [{ ...shared, subscribed: false }]);
  serverLayers = [shared];
  const applied = vi.fn();
  await syncAnnotations(guest, { pull: true, onLayersApplied: applied });
  expect(applied).toHaveBeenCalledWith([{ ...shared, subscribed: false }]);
});

it("waits for a cross-tab fallback lease before refreshing and can cancel that wait", async () => {
  const acquired = deferred<void>(), release = deferred<void>();
  const held = withScoreSyncLock(workspace, async () => { acquired.resolve(); await release.promise; return true; });
  await acquired.promise;
  const controller = new AbortController();
  const cancelled = syncAnnotations(workspace, { pull: true, signal: controller.signal });
  const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  const requested = syncAnnotations(workspace, { pull: true });
  controller.abort();
  await rejected;
  expect(fetch).not.toHaveBeenCalled();
  release.resolve();
  await held;
  await expect(requested).resolves.toEqual({ pushed: 0, pulled: 0 });
});

it("rejects an old fallback holder after an expired lease has been taken over", async () => {
  const oldResponse = deferred<Response>();
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).endsWith("/layers")) return emptyPull();
    requests++;
    return oldResponse.promise;
  }));
  const old = syncAnnotations(workspace, { pull: true });
  const rejected = expect(old).rejects.toThrow("local_workspace_owner_changed");
  await vi.waitFor(() => expect(requests).toBe(1));
  await localDatabase.syncLeases.update(workspace.scopeKey, { expiresAt: 0 });
  const acquired = deferred<void>(), release = deferred<void>();
  const successor = withScoreSyncLock(workspace, async locked => {
    await cacheAnnotationLayers(locked, [own]);
    acquired.resolve();
    await release.promise;
    return true;
  });
  await acquired.promise;
  oldResponse.resolve(Response.json({ layers: [own, published], sharedLayerRevision: 0, permissions: { canManageLayers: false } }));
  await rejected;
  expect(getAnnotationSyncActivity(workspace.scopeKey)).toBe("running");
  expect(await readAnnotationLayers(workspace)).toEqual([expect.objectContaining(own)]);
  release.resolve();
  await successor;
  expect(getAnnotationSyncActivity(workspace.scopeKey)).toBe("idle");
});

it.each([
  { response: () => new Response(null, { status: 403 }), step: 'sync-layers-request', errorCode: 'annotation_layer_access_denied' },
  { response: () => new Response('not json'), step: 'sync-layers-response', errorCode: 'invalid_server_response' },
  { response: () => Response.json({ layers: [], sharedLayerRevision: 0, permissions: { canManageLayers: false } }), step: 'sync-layers-identity', errorCode: 'annotation_layer_identity_mismatch' },
])('identifies $step without exporting response or exception text', async ({ response, step, errorCode }) => {
  const { clearDiagnostics, exportDiagnostics } = await import('../diagnostics/diagnostics');
  clearDiagnostics();
  vi.stubGlobal('fetch', vi.fn(response));
  await expect(syncAnnotations(workspace, { pull: true })).rejects.toThrow();
  expect(JSON.parse(exportDiagnostics()).records).toContainEqual(expect.objectContaining({ step, errorCode }));
  expect(exportDiagnostics()).not.toContain('not json');
});
