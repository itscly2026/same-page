import { hasCompleteOfflineLayers } from "../offline/offline-score-verification";
import { parseDiagnosticResponse, diagnosticFetch, recordFailure } from "../diagnostics/diagnostics";
import {
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
import { cacheAnnotationLayers, readAnnotationLayers, applyPulledAnnotations, applyPushResults, prepareAnnotationPush } from "./annotation-state";

export async function syncAnnotations(
  workspace: LocalWorkspace,
  options: { pull: boolean },
) {
  await assertLocalWorkspaceActive(workspace);
  return withScoreSyncLock(workspace, async (workspace) => {
    let pushed = 0;
    let pushError: unknown;
    try { pushed = await drainAnnotationOutbox(workspace); }
    catch (error) { pushError = error; }

    let pulled = 0;
    if (options.pull) {
      await assertLocalWorkspaceActive(workspace);
      const layerResponse = await diagnosticFetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/layers`, { signal: AbortSignal.timeout(30_000) });
      if (!layerResponse.ok) {
        if (layerResponse.status === 401 || layerResponse.status === 403 || layerResponse.status === 404) {
          const previous = await readAnnotationLayers(workspace);
          await cacheAnnotationLayers(workspace, previous.filter(layer => layer.kind !== "personal" || layer.canEdit));
        }
        throw new Error("annotation_layers_unavailable");
      }
      const { layers } = await parseDiagnosticResponse(layerResponse, annotationLayerListResponseSchema);
      const previous = await readAnnotationLayers(workspace);
      if (!hasCompleteOfflineLayers(layers, workspace.ownerKey)) {
        await cacheAnnotationLayers(workspace, previous.filter(layer => layer.kind !== "personal" || layer.canEdit));
        throw new Error("annotation_layer_identity_mismatch");
      }
      // Guest preferences live on this device; authenticated preferences come from the server.
      await cacheAnnotationLayers(workspace, workspace.ownerKey.startsWith("user:") ? layers : layers.map(layer => ({
        ...layer, subscribed: previous.find(entry => entry.id === layer.id)?.subscribed ?? layer.subscribed,
      })));
      const checkpoint = await localDatabase.annotationSyncCursors.get(workspace.scopeKey);
      const layerIds = layers.map(layer => layer.id).sort();
      let cursor = JSON.stringify(checkpoint?.layerIds) === JSON.stringify(layerIds) ? checkpoint?.cursor ?? 0 : 0;
      while (true) {
        const response = await diagnosticFetch(
          `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/annotations?cursor=${cursor}`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (!response.ok) throw new Error("annotation_pull_failed");
        const body = await parseDiagnosticResponse(response, annotationPullResponseSchema);
        await assertLocalWorkspaceActive(workspace);
        await applyPulledAnnotations(workspace, body.cursor, body.objects, layerIds);
        pulled += body.objects.length;
        if (!body.hasMore || body.cursor <= cursor) break;
        cursor = body.cursor;
      }
    }
    if (pushError) throw pushError;
    return { pushed, pulled };
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
  options: { maxOperations?: number } = {},
) {
  await assertLocalWorkspaceActive(workspace);
  let pushed = 0;
  const maxOperations = options.maxOperations ?? Number.POSITIVE_INFINITY;
  while (pushed < maxOperations) {
    const batch = await prepareAnnotationPush(workspace, maxOperations - pushed);
    if (batch.length === 0) return pushed;
    await assertLocalWorkspaceActive(workspace);
    const expectedUserId = authenticatedUserId(workspace);
    if (!expectedUserId) throw new Error("annotation_push_requires_user_owner");
    const response = await diagnosticFetch(
      `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/annotations/push`,
      {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          "x-same-page-owner-user-id": expectedUserId,
        },
        body: JSON.stringify({ operations: batch.map(toWireOperation) }),
      },
    );
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
  options: { ifAvailable?: boolean } = {},
) {
  workspace = await captureLocalWorkspaceSession(workspace);
  const scopeKey = workspace.scopeKey;
  if (navigator.locks) {
    return navigator.locks.request(`same-page:sync:${scopeKey}`, options, async (lock) => {
      if (!lock) return undefined;
      await assertLocalWorkspaceActive(workspace);
      return observeSync(workspace, () => action(workspace));
    });
  }
  const owner = crypto.randomUUID();
  const acquired = await withLocalWorkspaceTransaction(
    workspace,
    "rw",
    [localDatabase.syncLeases],
    async () => {
      const current = await localDatabase.syncLeases.get(scopeKey);
      if (current && current.expiresAt > Date.now()) return false;
      await localDatabase.system.put({ key: `annotation-sync-fence:${scopeKey}`, value: owner });
      await localDatabase.syncLeases.put({
        ...workspace,
        lockOwner: owner,
        expiresAt: Date.now() + 120_000,
      });
      return true;
    },
  );
  if (!acquired) return undefined;
  try {
    return await observeSync(workspace, () => action({ ...workspace, syncLockToken: owner }));
  } finally {
    await withLocalWorkspaceTransaction(
      workspace,
      "rw",
      [localDatabase.syncLeases],
      async () => {
        const current = await localDatabase.syncLeases.get(scopeKey);
        if (current?.lockOwner === owner) {
          await localDatabase.syncLeases.delete(scopeKey);
        }
      },
    ).catch((error: unknown) => {
      if (!(error instanceof LocalWorkspaceOwnerChangedError)) throw error;
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
export const subscribeAnnotationSync = (listener: () => void) => {
  syncListeners.add(listener);
  return () => { syncListeners.delete(listener); };
};
export const getAnnotationSyncActivity = (scopeKey: string) => syncActivity.get(scopeKey) ?? "idle";
async function observeSync<T>(workspace: LocalWorkspace, action: () => Promise<T>) {
  const publish = (state: "running" | "failed" | "idle") => {
    if (state === "idle") syncActivity.delete(workspace.scopeKey);
    else syncActivity.set(workspace.scopeKey, state);
    syncListeners.forEach(listener => listener());
  };
  publish("running");
  try {
    const result = await action();
    publish("idle");
    return result;
  } catch (error) {
    publish(error instanceof LocalWorkspaceOwnerChangedError ? "idle" : "failed");
    throw error;
  }
}
