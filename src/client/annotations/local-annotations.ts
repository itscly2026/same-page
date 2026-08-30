import type {
  AnnotationLayerSummary,
  AnnotationObjectRecord,
  AnnotationPayload,
} from "../../shared/annotations";
import {
  annotationRecordKey,
  annotationScopeKey,
  localDatabase,
  type AnnotationConflictRecord,
  type AnnotationOutboxRecord,
  type LocalAnnotationRecord,
} from "../platform/local-database";

export interface DraftInput {
  id: string;
  layerId: string;
  payload: AnnotationPayload | null;
  deleted?: boolean;
}

export async function cacheAnnotationLayers(
  choirId: string,
  scoreId: string,
  layers: AnnotationLayerSummary[],
) {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  await localDatabase.transaction("rw", localDatabase.annotationLayers, async () => {
    await localDatabase.annotationLayers.where("scopeKey").equals(scopeKey).delete();
    await localDatabase.annotationLayers.bulkPut(
      layers.map((layer) => ({
        ...layer,
        key: `${scopeKey}:${layer.id}`,
        scopeKey,
      })),
    );
  });
}

export async function updateCachedLayer(
  scopeKey: string,
  layerId: string,
  changes: Partial<Pick<AnnotationLayerSummary, "visible" | "colorOverride">>,
) {
  await localDatabase.annotationLayers.update(`${scopeKey}:${layerId}`, changes);
}

export async function saveAnnotationDraft(
  choirId: string,
  scoreId: string,
  input: DraftInput,
) {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  const key = annotationRecordKey(scopeKey, input.id);
  const existing = await localDatabase.annotations.get(key);
  const now = Date.now();
  await localDatabase.annotations.put({
    key,
    scopeKey,
    choirId,
    scoreId,
    id: input.id,
    layerId: input.layerId,
    version: existing?.version ?? 0,
    baseVersion: existing?.version ?? 0,
    deleted: input.deleted ?? input.payload === null,
    payload: input.payload,
    state: "draft",
    lastOpId: null,
    updatedAt: now,
  });
}

export async function removeUnsyncedAnnotation(scopeKey: string, annotationId: string) {
  const key = annotationRecordKey(scopeKey, annotationId);
  const existing = await localDatabase.annotations.get(key);
  if (existing?.version === 0 && existing.state === "draft") {
    await localDatabase.annotations.delete(key);
    return true;
  }
  return false;
}

export async function queueScoreDrafts(choirId: string, scoreId: string) {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  return localDatabase.transaction(
    "rw",
    localDatabase.annotations,
    localDatabase.annotationOutbox,
    async () => {
      const drafts = await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([scopeKey, "draft"])
        .toArray();
      for (const draft of drafts) {
        const unattempted = await localDatabase.annotationOutbox
          .where("[scopeKey+annotationId]")
          .equals([scopeKey, draft.id])
          .filter((operation) => operation.attemptedAt === null)
          .first();
        const opId = unattempted?.opId ?? crypto.randomUUID();
        const operation: AnnotationOutboxRecord = {
          opId,
          scopeKey,
          choirId,
          scoreId,
          annotationId: draft.id,
          layerId: draft.layerId,
          baseVersion: draft.baseVersion,
          type: draft.deleted ? "delete" : "upsert",
          payload: draft.deleted ? null : draft.payload,
          attemptedAt: null,
          createdAt: unattempted?.createdAt ?? Date.now(),
        };
        await localDatabase.annotationOutbox.put(operation);
        await localDatabase.annotations.update(draft.key, {
          state: "pending",
          lastOpId: opId,
        });
      }
      return drafts.length;
    },
  );
}

export async function applyPulledAnnotations(
  choirId: string,
  scoreId: string,
  cursor: number,
  objects: AnnotationObjectRecord[],
) {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  await localDatabase.transaction(
    "rw",
    localDatabase.annotations,
    localDatabase.annotationSyncCursors,
    async () => {
      for (const object of objects) {
        const key = annotationRecordKey(scopeKey, object.id);
        const existing = await localDatabase.annotations.get(key);
        if (existing && existing.state !== "synced") continue;
        await localDatabase.annotations.put(fromCanonical(scopeKey, choirId, scoreId, object));
      }
      await localDatabase.annotationSyncCursors.put({ scopeKey, cursor });
    },
  );
}

export async function applyPushResults(
  operations: AnnotationOutboxRecord[],
  results: Array<{
    opId: string;
    status: "accepted" | "conflict" | "op_id_reused";
    object?: AnnotationObjectRecord | null;
  }>,
) {
  const operationsById = new Map(operations.map((operation) => [operation.opId, operation]));
  await localDatabase.transaction(
    "rw",
    localDatabase.annotations,
    localDatabase.annotationOutbox,
    localDatabase.annotationConflicts,
    async () => {
      for (const result of results) {
        const operation = operationsById.get(result.opId);
        if (!operation) continue;
        const key = annotationRecordKey(operation.scopeKey, operation.annotationId);
        const local = await localDatabase.annotations.get(key);
        if (result.status === "accepted" && result.object) {
          if (local?.lastOpId === operation.opId) {
            await localDatabase.annotations.put(
              fromCanonical(
                operation.scopeKey,
                operation.choirId,
                operation.scoreId,
                result.object,
              ),
            );
          } else if (local) {
            await localDatabase.annotations.update(key, {
              version: result.object.version,
              baseVersion: result.object.version,
            });
          }
          const laterOperations = await localDatabase.annotationOutbox
            .where("[scopeKey+annotationId]")
            .equals([operation.scopeKey, operation.annotationId])
            .filter(
              (entry) =>
                entry.opId !== operation.opId && entry.attemptedAt === null,
            )
            .toArray();
          await localDatabase.annotationOutbox.bulkUpdate(
            laterOperations.map((entry) => ({
              key: entry.opId,
              changes: { baseVersion: result.object!.version },
            })),
          );
        } else {
          const relatedOperations = await localDatabase.annotationOutbox
            .where("[scopeKey+annotationId]")
            .equals([operation.scopeKey, operation.annotationId])
            .sortBy("createdAt");
          const latest = relatedOperations.at(-1) ?? operation;
          const conflict: AnnotationConflictRecord = {
            opId: operation.opId,
            scopeKey: operation.scopeKey,
            annotationId: operation.annotationId,
            layerId: operation.layerId,
            localPayload: latest.payload,
            localDeleted: latest.type === "delete",
            canonical: result.object ?? null,
            createdAt: Date.now(),
          };
          await localDatabase.annotationConflicts.put(conflict);
          if (local) {
            await localDatabase.annotations.update(key, { state: "conflict" });
          }
          await localDatabase.annotationOutbox.bulkDelete(
            relatedOperations.map((entry) => entry.opId),
          );
        }
        await localDatabase.annotationOutbox.delete(operation.opId);
      }
    },
  );
}

export async function discardAnnotationConflict(opId: string) {
  const conflict = await localDatabase.annotationConflicts.get(opId);
  if (!conflict) return;
  await localDatabase.transaction(
    "rw",
    localDatabase.annotations,
    localDatabase.annotationConflicts,
    async () => {
      const key = annotationRecordKey(conflict.scopeKey, conflict.annotationId);
      if (conflict.canonical) {
        const [choirId, ...scoreParts] = conflict.scopeKey.split(":");
        await localDatabase.annotations.put(
          fromCanonical(
            conflict.scopeKey,
            choirId,
            scoreParts.join(":"),
            conflict.canonical,
          ),
        );
      } else {
        await localDatabase.annotations.delete(key);
      }
      await localDatabase.annotationConflicts.delete(opId);
    },
  );
}

export async function reapplyAnnotationConflict(opId: string, keepBoth = false) {
  const conflict = await localDatabase.annotationConflicts.get(opId);
  if (!conflict) return;
  const current = await localDatabase.annotations.get(
    annotationRecordKey(conflict.scopeKey, conflict.annotationId),
  );
  if (!current) return;
  const nextId = keepBoth ? crypto.randomUUID() : conflict.annotationId;
  const canonicalVersion = keepBoth ? 0 : (conflict.canonical?.version ?? 0);
  await localDatabase.transaction(
    "rw",
    localDatabase.annotations,
    localDatabase.annotationConflicts,
    async () => {
      if (keepBoth && conflict.canonical) {
        await localDatabase.annotations.put(
          fromCanonical(
            conflict.scopeKey,
            current.choirId,
            current.scoreId,
            conflict.canonical,
          ),
        );
      }
      await localDatabase.annotations.put({
        ...current,
        key: annotationRecordKey(conflict.scopeKey, nextId),
        id: nextId,
        version: canonicalVersion,
        baseVersion: canonicalVersion,
        deleted: conflict.localDeleted,
        payload: conflict.localPayload,
        state: "draft",
        lastOpId: null,
        updatedAt: Date.now(),
      });
      await localDatabase.annotationConflicts.delete(opId);
    },
  );
}

export function visibleLocalAnnotations(scopeKey: string) {
  return localDatabase.annotations
    .where("scopeKey")
    .equals(scopeKey)
    .filter((annotation) => !annotation.deleted)
    .toArray();
}

function fromCanonical(
  scopeKey: string,
  choirId: string,
  scoreId: string,
  object: AnnotationObjectRecord,
): LocalAnnotationRecord {
  return {
    key: annotationRecordKey(scopeKey, object.id),
    scopeKey,
    choirId,
    scoreId,
    id: object.id,
    layerId: object.layerId,
    version: object.version,
    baseVersion: object.version,
    deleted: object.deleted,
    payload: object.payload,
    state: "synced",
    lastOpId: null,
    updatedAt: object.updatedAt,
  };
}
