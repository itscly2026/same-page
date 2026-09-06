import { hasCompleteOfflineLayers } from "../offline/offline-score-verification";
import { annotationLayerSummarySchema, annotationPayloadSchema } from "../../shared/annotations";
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
  type OfflineScoreRecord,
} from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  currentLocalOwnerKey,
  LocalWorkspaceOwnerChangedError,
  localWorkspaceRecordKey,
  type LocalWorkspace,
  type LocalWorkspaceOwnerKey,
  withLocalWorkspaceTransaction,
} from "../platform/local-workspace";

export function readAnnotationLayers(workspace: LocalWorkspace) {
  return withLocalWorkspaceTransaction(workspace, "r", [localDatabase.annotationLayers], () =>
    localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).toArray());
}

export function readScoreAnnotationState(workspace: LocalWorkspace) {
  return withLocalWorkspaceTransaction(workspace, "r", [localDatabase.annotationLayers, localDatabase.annotations, localDatabase.annotationOutbox, localDatabase.annotationConflicts], async () => {
    const [layers, annotations, pendingCount, conflicts] = await Promise.all([
      localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).toArray(),
      localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey).toArray(),
      localDatabase.annotationOutbox.where("scopeKey").equals(workspace.scopeKey).count(),
      localDatabase.annotationConflicts.where("scopeKey").equals(workspace.scopeKey).toArray(),
    ]);
    return { scopeKey: workspace.scopeKey, layersReady: hasCompleteOfflineLayers(layers, workspace.ownerKey), layers, annotations, pendingCount, conflicts, syncErrorCount: annotations.filter((annotation) => annotation.state === "sync-error").length };
  });
}

export interface DraftInput {
  id: string;
  layerId: string;
  payload: AnnotationPayload | null;
  deleted?: boolean;
}

export async function cacheAnnotationLayers(workspace: LocalWorkspace, layers: AnnotationLayerSummary[]) {
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.annotationLayers,
    localDatabase.annotations, localDatabase.annotationSyncCursors, localDatabase.offlineScores], async () => {
    const previous = await localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).toArray();
    const ids = new Set(layers.map(layer => layer.id));
    if (layers.some(layer => !previous.some(entry => entry.id === layer.id))) {
      await localDatabase.annotationSyncCursors.delete(workspace.scopeKey);
    }
    const revoked = new Set(previous.filter(layer => layer.kind === "personal" && !layer.canEdit && !ids.has(layer.id)).map(layer => layer.id));
    await localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey)
      .filter(annotation => revoked.has(annotation.layerId)).delete();
    // Offline snapshots are another copy of the same data. Scrub them too, so opening
    // an older PDF version cannot restore a withdrawn publication.
    await localDatabase.offlineScores.where("scopeKey").equals(workspace.scopeKey).modify(record => {
      if (!record.annotationSnapshot) return;
      const snapshot = record.annotationSnapshot;
      const inaccessible = new Set(snapshot.layers.filter(layer => layer.kind === "personal" && !layer.canEdit && !ids.has(layer.id)).map(layer => layer.id));
      snapshot.layers = snapshot.layers.filter(layer => !inaccessible.has(layer.id));
      snapshot.annotations = snapshot.annotations.filter(annotation => !inaccessible.has(annotation.layerId));
    });
    await localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).delete();
    await localDatabase.annotationLayers.bulkPut(layers.map(layer => ({ ...layer,
      key: localWorkspaceRecordKey(workspace, layer.id), ...workspace })));
  });
}

export async function updateCachedLayer(
  workspace: LocalWorkspace,
  layerId: string,
  changes: Partial<AnnotationLayerSummary>,
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
      localDatabase.annotationConflicts,
    ],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const key = annotationRecordKey(workspace.scopeKey, input.id);
      const existing = await localDatabase.annotations.get(key);
      if (existing && existing.layerId !== input.layerId) throw new Error("annotation_layer_is_immutable");
      const deleting = input.deleted ?? input.payload === null;
      if (existing?.state === "conflict") {
        await localDatabase.annotations.update(key, {
          payload: deleting ? null : input.payload, deleted: deleting, updatedAt: Date.now(),
        });
        await localDatabase.annotationConflicts.where("[scopeKey+annotationId]")
          .equals([workspace.scopeKey, input.id]).modify({
            localPayload: deleting ? null : input.payload, localDeleted: deleting,
          });
        return;
      }
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
        state: existing?.state === "sync-error" ? "sync-error" : "draft",
        lastOpId: null,
        syncErrorCode: existing?.syncErrorCode ?? null,
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
  layerIds?: string[],
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
        if (existing && (existing.state !== "synced" || existing.version > object.version)) continue;
        await localDatabase.annotations.put(fromCanonical(workspace, object));
      }
      await localDatabase.annotationSyncCursors.put({ ...workspace, cursor, layerIds });
    },
  );
}

export async function applyPushResults(
  workspace: LocalWorkspace,
  operations: AnnotationOutboxRecord[],
  results: Array<{
    opId: string;
    status: "accepted" | "conflict" | "op_id_reused" | "permission_denied";
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
        if (!operation || operation.scopeKey !== workspace.scopeKey ||
            !(await localDatabase.annotationOutbox.get(operation.opId))) continue;
        const key = annotationRecordKey(operation.scopeKey, operation.annotationId);
        const local = await localDatabase.annotations.get(key);
        if (result.status === "permission_denied") {
          if (local) await localDatabase.annotations.update(key, { state: "sync-error", syncErrorCode: "permission_denied" });
          continue;
        }
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
              localPayload: local ? local.payload : latest.payload,
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
  await localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationConflicts,
    async () => {
      await assertLocalWorkspaceActive(workspace);
      const conflict = await localDatabase.annotationConflicts.get(opId);
      if (!conflict || conflict.scopeKey !== workspace.scopeKey) return;
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
  await localDatabase.transaction(
    "rw",
    localDatabase.system,
    localDatabase.annotations,
    localDatabase.annotationConflicts,
    async () => {
      await assertLocalWorkspaceActive(workspace);
  const conflict = await localDatabase.annotationConflicts.get(opId);
  if (!conflict || conflict.scopeKey !== workspace.scopeKey) return;
  const current = await localDatabase.annotations.get(
    annotationRecordKey(conflict.scopeKey, conflict.annotationId),
  );
  if (!current) return;
  const nextId = keepBoth ? crypto.randomUUID() : conflict.annotationId;
  const canonicalVersion = keepBoth ? 0 : (conflict.canonical?.version ?? 0);
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

interface HistoryEntry {
  before: DraftInput;
  after: DraftInput;
}

const undoByLayer = new Map<string, HistoryEntry[]>();
const redoByLayer = new Map<string, HistoryEntry[]>();
let historySession = 0;

export function beginAnnotationEditSession() {
  historySession++;
  undoByLayer.clear();
  redoByLayer.clear();
}

export function endAnnotationEditSession() {
  historySession++;
  undoByLayer.clear();
  redoByLayer.clear();
}

export async function saveDraftWithHistory(
  workspace: LocalWorkspace,
  input: DraftInput,
) {
  const session = historySession;
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.annotations, localDatabase.annotationOutbox, localDatabase.annotationConflicts], async () => {
  const before =
    (await localDatabase.annotations.get(
      annotationRecordKey(workspace.scopeKey, input.id),
    )) ?? null;
  await saveAnnotationDraft(workspace, input);
  if (session !== historySession) return;
  const stack = undoByLayer.get(historyKey(workspace, input.layerId)) ?? [];
  stack.push({ before: { id: input.id, layerId: input.layerId, payload: before?.payload ?? null, deleted: before?.deleted ?? true }, after: structuredClone(input) });
  undoByLayer.set(historyKey(workspace, input.layerId), stack);
  redoByLayer.set(historyKey(workspace, input.layerId), []);
  });
}

export async function updateLatestHistoryDraft(
  workspace: LocalWorkspace,
  input: DraftInput,
) {
  await saveAnnotationDraft(workspace, input);
  const stack = undoByLayer.get(historyKey(workspace, input.layerId));
  if (stack?.length) stack[stack.length - 1].after = input;
}

export async function undoAnnotationEdit(
  workspace: LocalWorkspace,
  layerId: string,
) {
  const undo = undoByLayer.get(historyKey(workspace, layerId)) ?? [];
  const entry = undo.at(-1);
  if (!entry) return false;
  await saveAnnotationDraft(workspace, entry.before);
  undo.pop();
  const redo = redoByLayer.get(historyKey(workspace, layerId)) ?? [];
  redo.push(entry);
  redoByLayer.set(historyKey(workspace, layerId), redo);
  return true;
}

export async function redoAnnotationEdit(
  workspace: LocalWorkspace,
  layerId: string,
) {
  const redo = redoByLayer.get(historyKey(workspace, layerId)) ?? [];
  const entry = redo.at(-1);
  if (!entry) return false;
  await saveAnnotationDraft(workspace, entry.after);
  redo.pop();
  const undo = undoByLayer.get(historyKey(workspace, layerId)) ?? [];
  undo.push(entry);
  undoByLayer.set(historyKey(workspace, layerId), undo);
  return true;
}

function historyKey(workspace: LocalWorkspace, layerId: string) {
  return JSON.stringify([workspace.scopeKey, layerId]);
}

export async function prepareAnnotationPush(workspace: LocalWorkspace, maxOperations: number) {
  return withLocalWorkspaceTransaction(
      workspace,
      "rw",
      [
        localDatabase.annotations,
        localDatabase.annotationOutbox,
        localDatabase.annotationConflicts,
      ],
      async () => {
        const operations = await localDatabase.annotationOutbox
          .where("scopeKey")
          .equals(workspace.scopeKey)
          .sortBy("createdAt");
        operations.sort((a, b) => Number(a.attemptedAt === null) - Number(b.attemptedAt === null) || a.createdAt - b.createdAt || a.opId.localeCompare(b.opId));
        const blocked = new Set((await localDatabase.annotations.where("[scopeKey+state]").equals([workspace.scopeKey, "sync-error"]).toArray()).map(record => record.id));
        const discardedOperationIds = new Set<string>();
        for (const invalidDelete of operations.filter(
          (operation) =>
            operation.baseVersion === 0 && operation.type === "delete",
        )) {
          const related = operations.filter(
            (operation) =>
              operation.annotationId === invalidDelete.annotationId,
          );
          const attemptedCreate = related.find(
            (operation) =>
              operation.baseVersion === 0 &&
              operation.type === "upsert" &&
              operation.attemptedAt !== null,
          );
          discardedOperationIds.add(invalidDelete.opId);
          if (attemptedCreate) {
            for (const operation of related) {
              if (operation.attemptedAt === null) {
                discardedOperationIds.add(operation.opId);
              }
            }
            const local = await localDatabase.annotations.get(
              annotationRecordKey(workspace.scopeKey, invalidDelete.annotationId),
            );
            if (local?.version === 0) {
              await localDatabase.annotations.update(local.key, {
                deleted: true,
                payload: null,
                state: "pending",
                lastOpId: attemptedCreate.opId,
              });
            }
            continue;
          }
          for (const operation of related) {
            if (operation.attemptedAt === null) {
              discardedOperationIds.add(operation.opId);
            }
          }
          const key = annotationRecordKey(
            workspace.scopeKey,
            invalidDelete.annotationId,
          );
          const local = await localDatabase.annotations.get(key);
          if (local?.version === 0 && local.deleted) {
            await localDatabase.annotations.delete(key);
          }
          const pseudoConflicts = await localDatabase.annotationConflicts
            .where("[scopeKey+annotationId]")
            .equals([workspace.scopeKey, invalidDelete.annotationId])
            .filter(
              (conflict) =>
                conflict.opId === invalidDelete.opId &&
                conflict.localDeleted &&
                conflict.canonical === null,
            )
            .toArray();
          await localDatabase.annotationConflicts.bulkDelete(
            pseudoConflicts.map((conflict) => conflict.opId),
          );
        }
        await localDatabase.annotationOutbox.bulkDelete([
          ...discardedOperationIds,
        ]);
        const seenAnnotationIds = new Set<string>();
        const selected = operations
          .filter(
            (operation) => !discardedOperationIds.has(operation.opId),
          )
          .filter((operation) => {
            if (blocked.has(operation.annotationId) || seenAnnotationIds.has(operation.annotationId)) return false;
            seenAnnotationIds.add(operation.annotationId);
            return true;
          })
          .slice(0, Math.min(100, maxOperations));
        for (const operation of selected) {
          assertOutboxOperation(operation);
        }
        await localDatabase.annotationOutbox.bulkUpdate(
          selected.map((operation) => ({
            key: operation.opId,
            changes: { attemptedAt: Date.now() },
          })),
        );
        return selected;
      },
    );
}

function assertOutboxOperation(operation: AnnotationOutboxRecord) {
  if (operation.baseVersion === 0 && operation.type === "delete") {
    throw new Error("annotation_outbox_invariant_version_zero_delete");
  }
}

export async function restoreOfflineAnnotationSnapshot(
  workspace: LocalWorkspace,
  record: OfflineScoreRecord,
) {
  await assertLocalWorkspaceActive(workspace);
  if (record.scopeKey !== workspace.scopeKey) return;
  const snapshot = (await localDatabase.offlineScores.get(record.key))?.annotationSnapshot ?? record.annotationSnapshot;
  if (!snapshot) return;
  for (const layer of snapshot.layers) annotationLayerSummarySchema.parse(layer);
  for (const annotation of snapshot.annotations) {
    if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
  }
  await withLocalWorkspaceTransaction(
    workspace,
    "rw",
    [
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationSyncCursors,
    ],
    async () => {
      for (const layer of snapshot.layers) {
        if (layer.scopeKey === workspace.scopeKey && layer.ownerKey === workspace.ownerKey && !(await localDatabase.annotationLayers.get(layer.key))) {
          await localDatabase.annotationLayers.put(layer);
        }
      }
      for (const annotation of snapshot.annotations) {
        if (!(await localDatabase.annotations.get(annotation.key))) {
          if (annotation.scopeKey !== workspace.scopeKey || annotation.ownerKey !== workspace.ownerKey) continue;
          // Snapshots do not contain outbox/conflict rows. Restore unsynced intent as
          // a draft, never orphan pending/conflict metadata from an older snapshot.
          await localDatabase.annotations.put(annotation.state === "synced" ? annotation : {
            ...annotation, state: "draft", lastOpId: null, syncErrorCode: null,
          });
        }
      }
      if (!(await localDatabase.annotationSyncCursors.get(workspace.scopeKey))) {
        await localDatabase.annotationSyncCursors.put({
          ...workspace,
          cursor: snapshot.cursor,
        });
      }
    },
  );
}


// Explicit logout command; the caller owns the surrounding offline-copy transaction.
export async function retainGuestSharedAnnotations(
  ownerKey: LocalWorkspaceOwnerKey,
  guestWorkspace: (choirId: string, scoreId: string) => Promise<LocalWorkspace>,
) {
      if ((await currentLocalOwnerKey()) !== ownerKey) throw new LocalWorkspaceOwnerChangedError();
      const layers = await localDatabase.annotationLayers
        .where("ownerKey")
        .equals(ownerKey)
        .toArray();
      const annotations = await localDatabase.annotations
        .where("ownerKey")
        .equals(ownerKey)
        .toArray();
      const sharedLayers = layers.filter((layer) => layer.kind === "shared");
      const sharedLayerIds = new Set(sharedLayers.map((layer) => layer.id));
      const sharedAnnotations = annotations.filter(
        (annotation) =>
          sharedLayerIds.has(annotation.layerId) &&
          annotation.state === "synced",
      );
      const nextLayers = await Promise.all(
        sharedLayers.map(async (layer) => {
          const workspace = await guestWorkspace(layer.choirId, layer.scoreId);
          return {
            ...layer,
            ...workspace,
            key: localWorkspaceRecordKey(workspace, layer.id),
            canEdit: false,
            scoreSubscriptionOverride: null,
            subscribed: true,
          };
        }),
      );
      const nextAnnotations = await Promise.all(
        sharedAnnotations.map(async (annotation) => {
          const workspace = await guestWorkspace(
            annotation.choirId,
            annotation.scoreId,
          );
          return {
            ...annotation,
            ...workspace,
            key: annotationRecordKey(workspace.scopeKey, annotation.id),
          };
        }),
      );
      const [outbox, conflicts, cursors, leases] = await Promise.all([
        localDatabase.annotationOutbox.where("ownerKey").equals(ownerKey).primaryKeys(),
        localDatabase.annotationConflicts.where("ownerKey").equals(ownerKey).primaryKeys(),
        localDatabase.annotationSyncCursors.where("ownerKey").equals(ownerKey).primaryKeys(),
        localDatabase.syncLeases.where("ownerKey").equals(ownerKey).primaryKeys(),
      ]);
      await Promise.all([
        localDatabase.annotationLayers.bulkDelete(layers.map((layer) => layer.key)),
        localDatabase.annotations.bulkDelete(
          annotations.map((annotation) => annotation.key),
        ),
        localDatabase.annotationOutbox.bulkDelete(outbox),
        localDatabase.annotationConflicts.bulkDelete(conflicts),
        localDatabase.annotationSyncCursors.bulkDelete(cursors),
        localDatabase.syncLeases.bulkDelete(leases),
      ]);
      await Promise.all([
        localDatabase.annotationLayers.bulkPut(nextLayers),
        localDatabase.annotations.bulkPut(nextAnnotations),
      ]);
}
