import type {
  AnnotationLayerSummary,
  AnnotationObjectRecord,
  AnnotationPayload,
} from "../../shared/annotations";
import {
  annotationRecordKey,
  localDatabase,
  type AnnotationConflictRecord,
  type AnnotationOutboxRecord,
  type LocalAnnotationRecord,
} from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  localWorkspaceRecordKey,
  type LocalWorkspace,
} from "../platform/local-workspace";

export interface DraftInput {
  id: string;
  layerId: string;
  payload: AnnotationPayload | null;
  deleted?: boolean;
}

export async function cacheAnnotationLayers(
  workspace: LocalWorkspace,
  layers: AnnotationLayerSummary[],
) {
  await assertLocalWorkspaceActive(workspace);
  await localDatabase.transaction(
    "rw",
    [localDatabase.system, localDatabase.annotationLayers],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      await localDatabase.annotationLayers
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .delete();
      await localDatabase.annotationLayers.bulkPut(
        layers.map((layer) => ({
          ...layer,
          key: localWorkspaceRecordKey(workspace, layer.id),
          ...workspace,
        })),
      );
    },
  );
}

export async function updateCachedLayer(
  workspace: LocalWorkspace,
  layerId: string,
  changes: Partial<Pick<AnnotationLayerSummary, "visible" | "colorOverride">>,
) {
  await assertLocalWorkspaceActive(workspace);
  await localDatabase.transaction(
    "rw",
    [localDatabase.system, localDatabase.annotationLayers],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      await localDatabase.annotationLayers.update(
        localWorkspaceRecordKey(workspace, layerId),
        changes,
      );
    },
  );
}

export async function updateCachedLayerMetadata(
  workspace: LocalWorkspace,
  layerId: string,
  changes: Partial<
    Pick<AnnotationLayerSummary, "name" | "defaultColor" | "sortOrder">
  >,
) {
  await assertLocalWorkspaceActive(workspace);
  await localDatabase.transaction(
    "rw",
    [localDatabase.system, localDatabase.annotationLayers],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      await localDatabase.annotationLayers.update(
        localWorkspaceRecordKey(workspace, layerId),
        changes,
      );
    },
  );
}

export async function saveAnnotationDraft(
  workspace: LocalWorkspace,
  input: DraftInput,
) {
  await assertLocalWorkspaceActive(workspace);
  await localDatabase.transaction(
    "rw",
    [
      localDatabase.system,
      localDatabase.annotations,
      localDatabase.annotationOutbox,
    ],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const key = annotationRecordKey(workspace.scopeKey, input.id);
      const existing = await localDatabase.annotations.get(key);
      const deleting = input.deleted ?? input.payload === null;
      if (deleting && (!existing || existing.version === 0)) {
        const operations = await localDatabase.annotationOutbox
          .where("[scopeKey+annotationId]")
          .equals([workspace.scopeKey, input.id])
          .toArray();
        const attemptedCreate = operations.find(
          (operation) =>
            operation.baseVersion === 0 &&
            operation.type === "upsert" &&
            operation.attemptedAt !== null,
        );
        await localDatabase.annotationOutbox.bulkDelete(
          operations
            .filter((operation) => operation.attemptedAt === null)
            .map((operation) => operation.opId),
        );
        if (!existing || !attemptedCreate) {
          await localDatabase.annotations.delete(key);
          return;
        }
        await localDatabase.annotations.put({
          ...existing,
          layerId: input.layerId,
          deleted: true,
          payload: null,
          state: "draft",
          lastOpId: attemptedCreate.opId,
          syncErrorCode: null,
          updatedAt: Date.now(),
        });
        return;
      }
      await localDatabase.annotations.put({
        key,
        ...workspace,
        id: input.id,
        layerId: input.layerId,
        version: existing?.version ?? 0,
        baseVersion: existing?.version ?? 0,
        deleted: deleting,
        payload: input.payload,
        state: "draft",
        lastOpId: null,
        syncErrorCode: null,
        updatedAt: Date.now(),
      });
    },
  );
}

export async function cleanupUncreatedDeleteConflicts(
  workspace: LocalWorkspace,
) {
  await assertLocalWorkspaceActive(workspace);
  return localDatabase.transaction(
    "rw",
    [
      localDatabase.system,
      localDatabase.annotations,
      localDatabase.annotationOutbox,
      localDatabase.annotationConflicts,
    ],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const conflicts = await localDatabase.annotationConflicts
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .filter(
          (conflict) => conflict.localDeleted && conflict.canonical === null,
        )
        .toArray();
      let cleaned = 0;
      for (const conflict of conflicts) {
        const key = annotationRecordKey(conflict.scopeKey, conflict.annotationId);
        const local = await localDatabase.annotations.get(key);
        if (
          !local ||
          local.version !== 0 ||
          local.baseVersion !== 0 ||
          !local.deleted
        ) {
          continue;
        }
        const operations = await localDatabase.annotationOutbox
          .where("[scopeKey+annotationId]")
          .equals([workspace.scopeKey, conflict.annotationId])
          .toArray();
        await localDatabase.annotationOutbox.bulkDelete(
          operations.map((operation) => operation.opId),
        );
        await localDatabase.annotations.delete(key);
        await localDatabase.annotationConflicts.delete(conflict.opId);
        cleaned += 1;
      }
      return cleaned;
    },
  );
}

export async function queueScoreDrafts(workspace: LocalWorkspace) {
  await assertLocalWorkspaceActive(workspace);
  return localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationOutbox,
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const drafts = await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([workspace.scopeKey, "draft"])
        .toArray();
      let queued = 0;
      for (const draft of drafts) {
        const relatedOperations = await localDatabase.annotationOutbox
          .where("[scopeKey+annotationId]")
          .equals([workspace.scopeKey, draft.id])
          .toArray();
        if (draft.deleted && draft.baseVersion === 0) {
          const attemptedCreate = relatedOperations.find(
            (operation) =>
              operation.baseVersion === 0 &&
              operation.type === "upsert" &&
              operation.attemptedAt !== null,
          );
          await localDatabase.annotationOutbox.bulkDelete(
            relatedOperations
              .filter((operation) => operation.attemptedAt === null)
              .map((operation) => operation.opId),
          );
          if (!attemptedCreate) {
            await localDatabase.annotations.delete(draft.key);
            continue;
          }
          await localDatabase.annotations.update(draft.key, {
            state: "pending",
            lastOpId: attemptedCreate.opId,
          });
          queued += 1;
          continue;
        }
        const unattempted = relatedOperations.find(
          (operation) => operation.attemptedAt === null,
        );
        const opId = unattempted?.opId ?? crypto.randomUUID();
        const operation: AnnotationOutboxRecord = {
          opId,
          ...workspace,
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
        queued += 1;
      }
      return queued;
    },
  );
}

export async function applyPulledAnnotations(
  workspace: LocalWorkspace,
  cursor: number,
  objects: AnnotationObjectRecord[],
) {
  await assertLocalWorkspaceActive(workspace);
  await localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationSyncCursors,
    async () => {
      await assertLocalWorkspaceActive(workspace);
      for (const object of objects) {
        const key = annotationRecordKey(workspace.scopeKey, object.id);
        const existing = await localDatabase.annotations.get(key);
        if (existing && existing.state !== "synced") continue;
        await localDatabase.annotations.put(fromCanonical(workspace, object));
      }
      await localDatabase.annotationSyncCursors.put({ ...workspace, cursor });
    },
  );
}

export async function applyPushResults(
  workspace: LocalWorkspace,
  operations: AnnotationOutboxRecord[],
  results: Array<{
    opId: string;
    status: "accepted" | "conflict" | "op_id_reused";
    object?: AnnotationObjectRecord | null;
  }>,
) {
  await assertLocalWorkspaceActive(workspace);
  const operationsById = new Map(operations.map((operation) => [operation.opId, operation]));
  await localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationOutbox,
    localDatabase.annotationConflicts,
    async () => {
      await assertLocalWorkspaceActive(workspace);
      for (const result of results) {
        const operation = operationsById.get(result.opId);
        if (!operation) continue;
        const key = annotationRecordKey(operation.scopeKey, operation.annotationId);
        const local = await localDatabase.annotations.get(key);
        if (result.status === "accepted" && result.object) {
          const deleteFollowsCreate =
            operation.baseVersion === 0 &&
            operation.type === "upsert" &&
            local?.lastOpId === operation.opId &&
            local.deleted &&
            !result.object.deleted;
          if (deleteFollowsCreate) {
            const deleteOpId = crypto.randomUUID();
            await localDatabase.annotationOutbox.put({
              opId: deleteOpId,
              ...workspace,
              annotationId: local.id,
              layerId: local.layerId,
              baseVersion: result.object.version,
              type: "delete",
              payload: null,
              attemptedAt: null,
              createdAt: Date.now(),
            });
            await localDatabase.annotations.update(key, {
              version: result.object.version,
              baseVersion: result.object.version,
              state: "pending",
              lastOpId: deleteOpId,
            });
          } else if (local?.lastOpId === operation.opId) {
            await localDatabase.annotations.put(
              fromCanonical(workspace, result.object),
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
        } else if (result.status === "conflict") {
          const relatedOperations = await localDatabase.annotationOutbox
            .where("[scopeKey+annotationId]")
            .equals([operation.scopeKey, operation.annotationId])
            .sortBy("createdAt");
          const uncreatedDelete =
            operation.baseVersion === 0 &&
            operation.type === "delete" &&
            result.object == null &&
            local?.version === 0 &&
            local.deleted;
          if (uncreatedDelete) {
            await localDatabase.annotations.delete(key);
          } else {
            const latest = relatedOperations.at(-1) ?? operation;
            const conflict: AnnotationConflictRecord = {
              opId: operation.opId,
              ...workspace,
              annotationId: operation.annotationId,
              layerId: operation.layerId,
              localPayload: local?.deleted ? null : latest.payload,
              localDeleted: local?.deleted ?? latest.type === "delete",
              canonical: result.object ?? null,
              createdAt: Date.now(),
            };
            await localDatabase.annotationConflicts.put(conflict);
            if (local) {
              await localDatabase.annotations.update(key, {
                state: "conflict",
                syncErrorCode: null,
              });
            }
          }
          await localDatabase.annotationOutbox.bulkDelete(
            relatedOperations.map((entry) => entry.opId),
          );
        } else {
          const relatedOperations = await localDatabase.annotationOutbox
            .where("[scopeKey+annotationId]")
            .equals([operation.scopeKey, operation.annotationId])
            .toArray();
          if (local) {
            await localDatabase.annotations.update(key, {
              state: "sync-error",
              lastOpId: null,
              syncErrorCode: "op_id_reused",
            });
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

export async function discardAnnotationConflict(
  workspace: LocalWorkspace,
  opId: string,
) {
  await assertLocalWorkspaceActive(workspace);
  const conflict = await localDatabase.annotationConflicts.get(opId);
  if (!conflict || conflict.ownerKey !== workspace.ownerKey) return;
  await localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationConflicts,
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const key = annotationRecordKey(conflict.scopeKey, conflict.annotationId);
      if (conflict.canonical) {
        await localDatabase.annotations.put(
          fromCanonical(workspace, conflict.canonical),
        );
      } else {
        await localDatabase.annotations.delete(key);
      }
      await localDatabase.annotationConflicts.delete(opId);
    },
  );
}

export async function reapplyAnnotationConflict(
  workspace: LocalWorkspace,
  opId: string,
  keepBoth = false,
) {
  await assertLocalWorkspaceActive(workspace);
  const conflict = await localDatabase.annotationConflicts.get(opId);
  if (!conflict || conflict.ownerKey !== workspace.ownerKey) return;
  const current = await localDatabase.annotations.get(
    annotationRecordKey(conflict.scopeKey, conflict.annotationId),
  );
  if (!current) return;
  const nextId = keepBoth ? crypto.randomUUID() : conflict.annotationId;
  const canonicalVersion = keepBoth ? 0 : (conflict.canonical?.version ?? 0);
  await localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationConflicts,
    async () => {
      await assertLocalWorkspaceActive(workspace);
      if (keepBoth && conflict.canonical) {
        await localDatabase.annotations.put(
          fromCanonical(
            workspace,
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
        syncErrorCode: null,
        updatedAt: Date.now(),
      });
      await localDatabase.annotationConflicts.delete(opId);
    },
  );
}

export async function retryScoreSyncErrors(workspace: LocalWorkspace) {
  await assertLocalWorkspaceActive(workspace);
  return localDatabase.transaction(
    "rw",
    [localDatabase.system, localDatabase.annotations],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const errors = await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([workspace.scopeKey, "sync-error"])
        .toArray();
      await localDatabase.annotations.bulkUpdate(
        errors.map((annotation) => ({
          key: annotation.key,
          changes: {
            state: "draft" as const,
            lastOpId: null,
            syncErrorCode: null,
          },
        })),
      );
      return errors.length;
    },
  );
}

export function visibleLocalAnnotations(workspace: LocalWorkspace) {
  return localDatabase.annotations
    .where("scopeKey")
    .equals(workspace.scopeKey)
    .filter((annotation) => !annotation.deleted)
    .toArray();
}

function fromCanonical(
  workspace: LocalWorkspace,
  object: AnnotationObjectRecord,
): LocalAnnotationRecord {
  return {
    key: annotationRecordKey(workspace.scopeKey, object.id),
    ...workspace,
    id: object.id,
    layerId: object.layerId,
    version: object.version,
    baseVersion: object.version,
    deleted: object.deleted,
    payload: object.payload,
    state: "synced",
    lastOpId: null,
    syncErrorCode: null,
    updatedAt: object.updatedAt,
  };
}
