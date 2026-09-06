import { hasCompleteOfflineLayers } from "../offline/offline-score-verification";
import { parseDiagnosticResponse, diagnosticFetch, recordFailure } from "../diagnostics/diagnostics";
import {
  type AnnotationLayerSummary,
  annotationPullResponseSchema,
  annotationLayerListResponseSchema,
  annotationPushResponseSchema,
} from "../../shared/annotations";
import {
  localDatabase,
  type AnnotationOutboxRecord,
} from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  captureLocalWorkspaceSession,
  LocalWorkspaceOwnerChangedError,
  type LocalWorkspace,
  withLocalWorkspaceTransaction,
} from "../platform/local-workspace";
import { removeCachedPublications, cacheAnnotationLayers, readAnnotationLayers, applyPulledAnnotations, applyPushResults, prepareAnnotationPush } from "./annotation-state";

type SyncResult = { pushed: number; pulled: number };
type SyncOptions = { pull: false } | {
  pull: true;
  signal?: AbortSignal;
  // Mutations and offline preparation require a layer request started after
  // this call. A reader may join the current refresh, including its ready layers.
  freshLayers?: boolean;
  onLayersApplied?: (layers: AnnotationLayerSummary[]) => void;
};
type RefreshTask = {
  workspace: LocalWorkspace;
  controller: AbortController;
  layersStartedAt: number | null;
  layers: AnnotationLayerSummary[] | null;
  listeners: Set<(layers: AnnotationLayerSummary[]) => void>;
  done: Promise<SyncResult>;
};
const refreshTasks = new Map<string, RefreshTask[]>();
let refreshOrder = 0;

// Callers observe committed layers early, but the promise means the entire
// synchronization succeeded. Neither a ready layer list nor a busy lock is success.
export async function syncAnnotations(workspace: LocalWorkspace, options: SyncOptions) {
  if (!options.pull) {
    return withScoreSyncLock(workspace, async locked => ({
      pushed: await drainAnnotationOutbox(locked), pulled: 0,
    }));
  }
  const requestedAt = ++refreshOrder;
  options.signal?.throwIfAborted();
  workspace = await captureLocalWorkspaceSession(workspace);
  options.signal?.throwIfAborted();
  const key = JSON.stringify([workspace.scopeKey, workspace.sessionEpoch]);
  // Re-entering the same account must neither reuse nor wait for its old
  // in-page refresh. Storage fencing remains authoritative across other tabs.
  for (const [otherKey, tasks] of refreshTasks) {
    if (otherKey !== key && tasks[0]?.workspace.scopeKey === workspace.scopeKey) {
      for (const stale of tasks) stale.controller.abort(new LocalWorkspaceOwnerChangedError());
    }
  }
  const queue = refreshTasks.get(key) ?? [];
  let task = queue.find(entry => !entry.controller.signal.aborted &&
    (options.freshLayers === false || entry.layersStartedAt === null || entry.layersStartedAt >= requestedAt));
  if (!task) {
    const controller = new AbortController();
    task = { workspace, controller, layersStartedAt: null, layers: null, listeners: new Set(), done: Promise.resolve({ pushed: 0, pulled: 0 }) };
    const current = task;
    const previous = queue.at(-1);
    queue.push(current);
    refreshTasks.set(key, queue);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    current.done = Promise.resolve().then(async () => {
      // Wait outside the storage lock. The cycle below acquires it exactly once.
      if (previous) await untilAborted(previous.done.catch(() => undefined), signal);
      signal.throwIfAborted();
      const result = await withScoreSyncLock(workspace, locked => refreshAnnotations(locked, signal, () => {
        current.layersStartedAt = refreshOrder;
      }, layers => {
        current.layers = layers;
        for (const listener of current.listeners) listener(layers);
      }), { signal });
      if (!result) throw new Error("annotation_sync_busy");
      return result;
    });
    const remove = () => {
      const remaining = refreshTasks.get(key)?.filter(entry => entry !== current);
      if (remaining?.length) refreshTasks.set(key, remaining);
      else refreshTasks.delete(key);
    };
    void current.done.then(remove, remove);
  }
  return observeRefresh(task, options);
}

function observeRefresh(task: RefreshTask, options: Extract<SyncOptions, { pull: true }>) {
  return new Promise<SyncResult>((resolve, reject) => {
    let finished = false;
    const finish = (error: unknown, result?: SyncResult) => {
      if (finished) return;
      finished = true;
      task.listeners.delete(layersApplied);
      options.signal?.removeEventListener("abort", cancelled);
      if (!task.listeners.size) task.controller.abort();
      if (result) resolve(result);
      else reject(error);
    };
    const cancelled = () => finish(options.signal?.reason);
    const layersApplied = (layers: AnnotationLayerSummary[]) => {
      if (finished || options.signal?.aborted) return;
      // A consumer error only rejects that consumer, never the shared refresh.
      try { options.onLayersApplied?.(layers); }
      catch (error) { finish(error); }
    };
    task.listeners.add(layersApplied);
    options.signal?.addEventListener("abort", cancelled, { once: true });
    void task.done.then(result => finish(null, result), error => finish(error));
    if (options.signal?.aborted) cancelled();
    else if (task.layers) layersApplied(task.layers);
  });
}

async function refreshAnnotations(
  workspace: LocalWorkspace,
  signal: AbortSignal,
  startingLayers: () => void,
  layersApplied: (layers: AnnotationLayerSummary[]) => void,
): Promise<SyncResult> {
  await assertLocalWorkspaceActive(workspace);
  signal.throwIfAborted();
  startingLayers();
  const base = `/api/choirs/${encodeURIComponent(workspace.choirId)}/scores/${encodeURIComponent(workspace.scoreId)}`;
  const layerResponse = await refreshRequest(`${base}/layers`, signal);
  await assertLocalWorkspaceActive(workspace);
  signal.throwIfAborted();
  if (!layerResponse.ok) {
    if ([401, 403, 404].includes(layerResponse.status)) await removeCachedPublications(workspace);
    throw new Error("annotation_layers_unavailable");
  }
  const { layers } = await parseDiagnosticResponse(layerResponse, annotationLayerListResponseSchema);
  await assertLocalWorkspaceActive(workspace);
  signal.throwIfAborted();
  if (!hasCompleteOfflineLayers(layers, workspace.ownerKey)) {
    await removeCachedPublications(workspace);
    throw new Error("annotation_layer_identity_mismatch");
  }
  const previous = await readAnnotationLayers(workspace);
  const applied = workspace.ownerKey.startsWith("user:") ? layers : layers.map(layer => ({
    ...layer, subscribed: previous.find(entry => entry.id === layer.id)?.subscribed ?? layer.subscribed,
  }));
  signal.throwIfAborted();
  await cacheAnnotationLayers(workspace, applied);
  await assertLocalWorkspaceActive(workspace);
  signal.throwIfAborted();
  layersApplied(applied);

  // Publish capability before slow pushes or paginated pulls. A rejected push
  // still allows readable cloud changes and revocations to reach this device.
  let pushed = 0;
  let pushError: unknown;
  try { pushed = await drainAnnotationOutbox(workspace, { signal }); }
  catch (error) { pushError = error; }
  signal.throwIfAborted();
  await assertLocalWorkspaceActive(workspace);
  const checkpoint = await localDatabase.annotationSyncCursors.get(workspace.scopeKey);
  const layerIds = applied.map(layer => layer.id).sort();
  let cursor = JSON.stringify(checkpoint?.layerIds) === JSON.stringify(layerIds) ? checkpoint?.cursor ?? 0 : 0;
  let pulled = 0;
  while (true) {
    const response = await refreshRequest(`${base}/annotations?cursor=${cursor}`, signal);
    await assertLocalWorkspaceActive(workspace);
    signal.throwIfAborted();
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) await removeCachedPublications(workspace);
      throw new Error("annotation_pull_failed");
    }
    const body = await parseDiagnosticResponse(response, annotationPullResponseSchema);
    signal.throwIfAborted();
    await applyPulledAnnotations(workspace, body.cursor, body.objects, layerIds);
    pulled += body.objects.length;
    if (!body.hasMore || body.cursor <= cursor) break;
    cursor = body.cursor;
  }
  if (pushError) throw pushError;
  return { pushed, pulled };
}

function refreshRequest(url: string, signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  return untilAborted(diagnosticFetch(url, { signal: requestSignal }), requestSignal);
}

// Also detaches promptly from lock waits and transports that cannot cancel.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    if (signal.aborted) cancel();
  });
}

export class AnnotationPushError extends Error {
  constructor(readonly responseStatus: number) {
    super("annotation_push_failed");
  }
}

export async function pushPendingAnnotations(
  workspace: LocalWorkspace,
  options: { maxOperations: number },
) {
  await assertLocalWorkspaceActive(workspace);
  return withScoreSyncLock(workspace, (workspace) =>
    drainAnnotationOutbox(workspace, options),
    { ifAvailable: true },
  );
}

async function drainAnnotationOutbox(
  workspace: LocalWorkspace,
  options: { maxOperations?: number; signal?: AbortSignal } = {},
) {
  await assertLocalWorkspaceActive(workspace);
  let pushed = 0;
  const maxOperations = options.maxOperations ?? Number.POSITIVE_INFINITY;
  while (pushed < maxOperations) {
    const batch = await prepareAnnotationPush(workspace, maxOperations - pushed);
    if (batch.length === 0) return pushed;
    await assertLocalWorkspaceActive(workspace);
    options.signal?.throwIfAborted();
    const expectedUserId = authenticatedUserId(workspace);
    if (!expectedUserId) throw new Error("annotation_push_requires_user_owner");
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
    const response = await untilAborted(diagnosticFetch(
      `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/annotations/push`,
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-same-page-owner-user-id": expectedUserId,
        },
        body: JSON.stringify({ operations: batch.map(toWireOperation) }),
      },
    ), signal);
    options.signal?.throwIfAborted();
    if (!response.ok) throw new AnnotationPushError(response.status);
    const body = await parseDiagnosticResponse(response, annotationPushResponseSchema);
    await assertLocalWorkspaceActive(workspace);
    if (body.results.length !== batch.length || new Set(body.results.map(result => result.opId)).size !== batch.length || body.results.some(result => !batch.some(op => op.opId === result.opId))) {
      throw new Error("annotation_push_incomplete_response");
    }
    if (body.results.some((result) => result.status === "conflict")) {
      recordFailure({ operation: "sync", category: "conflict", stage: "push" });
    }
    if (body.results.some((result) => result.status === "op_id_reused")) {
      recordFailure({ operation: "sync", category: "validation", stage: "push" });
    }
    options.signal?.throwIfAborted();
    await applyPushResults(workspace, batch, body.results);
    pushed += batch.length;
  }
  return pushed;
}

function authenticatedUserId(workspace: LocalWorkspace) {
  return workspace.ownerKey.startsWith("user:")
    ? workspace.ownerKey.slice("user:".length)
    : null;
}

export async function withScoreSyncLock<T>(
  workspace: LocalWorkspace,
  action: (workspace: LocalWorkspace) => Promise<T>,
  options: { ifAvailable?: boolean; signal?: AbortSignal } = {},
) {
  workspace = await captureLocalWorkspaceSession(workspace);
  options.signal?.throwIfAborted();
  const scopeKey = workspace.scopeKey;
  if (navigator.locks) {
    return navigator.locks.request(`same-page:sync:${scopeKey}`, options, async (lock) => {
      if (!lock) return undefined;
      await assertLocalWorkspaceActive(workspace);
      return observeSync(workspace, () => action(workspace));
    });
  }
  const owner = crypto.randomUUID();
  while (true) {
    options.signal?.throwIfAborted();
    const acquired = await withLocalWorkspaceTransaction(
      workspace,
      "rw",
      [localDatabase.syncLeases],
      async () => {
        const current = await localDatabase.syncLeases.get(scopeKey);
        if (current && current.expiresAt > Date.now() &&
            (current.sessionEpoch === undefined || current.sessionEpoch === workspace.sessionEpoch)) return false;
        await localDatabase.system.put({ key: `annotation-sync-fence:${scopeKey}`, value: owner });
        await localDatabase.syncLeases.put({
          ...workspace, lockOwner: owner, expiresAt: Date.now() + 120_000,
        });
        return true;
      },
    );
    if (acquired) break;
    if (!options.signal || options.ifAvailable) return undefined;
    await untilAborted(new Promise<void>(resolve => setTimeout(resolve, 50)), options.signal);
  }
  try {
    return await observeSync(workspace, () => action({ ...workspace, syncLockToken: owner }));
  } finally {
    // Releasing our own lease needs no active identity. An expired session
    // must not strand the next session, nor delete a successor's lease.
    await localDatabase.transaction("rw", localDatabase.syncLeases, async () => {
      const current = await localDatabase.syncLeases.get(scopeKey);
      if (current?.lockOwner === owner) await localDatabase.syncLeases.delete(scopeKey);
    });
  }
}

function toWireOperation(operation: AnnotationOutboxRecord) {
  return {
    opId: operation.opId,
    annotationId: operation.annotationId,
    layerId: operation.layerId,
    baseVersion: operation.baseVersion,
    type: operation.type,
    payload: operation.payload,
  };
}

// Observe the existing sync lock, including background recovery, without
// treating request completion as proof that every local object was accepted.
const syncActivity = new Map<string, "running" | "failed">();
const syncListeners = new Set<() => void>();
const syncActivityOwners = new Map<string, symbol>();
export const subscribeAnnotationSync = (listener: () => void) => {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
};
export const getAnnotationSyncActivity = (scopeKey: string) => syncActivity.get(scopeKey) ?? "idle";
async function observeSync<T>(workspace: LocalWorkspace, action: () => Promise<T>) {
  const owner = Symbol();
  syncActivityOwners.set(workspace.scopeKey, owner);
  const publish = (state: "running" | "failed" | "idle") => {
    if (syncActivityOwners.get(workspace.scopeKey) !== owner) return;
    if (state === "idle") { syncActivity.delete(workspace.scopeKey); syncActivityOwners.delete(workspace.scopeKey); }
    else syncActivity.set(workspace.scopeKey, state);
    syncListeners.forEach(listener => listener());
  };
  publish("running");
  try {
    const result = await action();
    publish("idle");
    return result;
  } catch (error) {
    publish(error instanceof LocalWorkspaceOwnerChangedError ||
      (error instanceof DOMException && error.name === "AbortError") ? "idle" : "failed");
    throw error;
  }
}
