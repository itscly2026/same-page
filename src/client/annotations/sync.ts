import {
  annotationPullResponseSchema,
  type AnnotationObjectRecord,
} from "../../shared/annotations";
import {
  annotationScopeKey,
  localDatabase,
  type AnnotationOutboxRecord,
} from "../platform/local-database";
import { applyPulledAnnotations, applyPushResults } from "./local-annotations";

export async function syncAnnotations(
  choirId: string,
  scoreId: string,
  options: { pull: boolean },
) {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  return withScoreSyncLock(scopeKey, async () => {
    const pushed = await drainAnnotationOutbox(choirId, scoreId);
    let pulled = 0;
    if (options.pull) {
      const cursor = (await localDatabase.annotationSyncCursors.get(scopeKey))?.cursor ?? 0;
      const response = await fetch(
        `/api/choirs/${choirId}/scores/${scoreId}/annotations?cursor=${cursor}`,
      );
      if (!response.ok) throw new Error("annotation_pull_failed");
      const body = annotationPullResponseSchema.parse(await response.json());
      await applyPulledAnnotations(choirId, scoreId, body.cursor, body.objects);
      pulled = body.objects.length;
    }
    return { pushed, pulled };
  });
}

export async function drainAnnotationOutbox(choirId: string, scoreId: string) {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  let pushed = 0;
  while (true) {
    const operations = await localDatabase.annotationOutbox
      .where("scopeKey")
      .equals(scopeKey)
      .sortBy("createdAt");
    const seenAnnotationIds = new Set<string>();
    const batch = operations
      .filter((operation) => {
        if (seenAnnotationIds.has(operation.annotationId)) return false;
        seenAnnotationIds.add(operation.annotationId);
        return true;
      })
      .slice(0, 100);
    if (batch.length === 0) return pushed;
    await localDatabase.annotationOutbox.bulkUpdate(
      batch.map((operation) => ({ key: operation.opId, changes: { attemptedAt: Date.now() } })),
    );
    const response = await fetch(
      `/api/choirs/${choirId}/scores/${scoreId}/annotations/push`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operations: batch.map(toWireOperation) }),
      },
    );
    if (!response.ok) throw new Error("annotation_push_failed");
    const body = (await response.json()) as {
      results: Array<{
        opId: string;
        status: "accepted" | "conflict" | "op_id_reused";
        object?: AnnotationObjectRecord | null;
      }>;
    };
    await applyPushResults(batch, body.results);
    pushed += batch.length;
  }
}

export async function withScoreSyncLock<T>(scopeKey: string, action: () => Promise<T>) {
  if (navigator.locks) {
    return navigator.locks.request(`same-page:sync:${scopeKey}`, action);
  }
  const owner = crypto.randomUUID();
  const acquired = await localDatabase.transaction("rw", localDatabase.syncLeases, async () => {
    const current = await localDatabase.syncLeases.get(scopeKey);
    if (current && current.expiresAt > Date.now()) return false;
    await localDatabase.syncLeases.put({
      scopeKey,
      owner,
      expiresAt: Date.now() + 120_000,
    });
    return true;
  });
  if (!acquired) return undefined;
  try {
    return await action();
  } finally {
    await localDatabase.transaction("rw", localDatabase.syncLeases, async () => {
      const current = await localDatabase.syncLeases.get(scopeKey);
      if (current?.owner === owner) await localDatabase.syncLeases.delete(scopeKey);
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
