import { GUEST_NOTE_LAYER_ID, guestNoteLayer, isLocalExperience } from "./guest-notes";
import { reconcileAnnotationReadingPreferences } from "../reader/reading-preferences";
import { diagnoseLocalOperation } from "../diagnostics/local-operation";
import { hasValidSnapshotShape, hasCompleteOfflineLayers } from "../offline/offline-score-verification";
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

export async function cacheAnnotationLayers(workspace: LocalWorkspace, layers: AnnotationLayerSummary[], sharedLayerRevision?: number, preferenceVersion?: string) {
  if (isLocalExperience(workspace)) layers = [
    ...layers.filter(layer => layer.kind === "shared").map(layer => ({ ...layer, canEdit: false })), guestNoteLayer(),
  ];
  return withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.annotationLayers,
    localDatabase.annotations, localDatabase.annotationSyncCursors, localDatabase.offlineSnapshots, localDatabase.readingPreferences], async () => {
    if (sharedLayerRevision !== undefined && !await acceptSharedLayerAvailability(workspace, {
      sharedLayerRevision, activeSharedSlots: layers.filter(layer => layer.kind === "shared").map(layer => layer.sharedSlot!),
    })) return false;
    if (sharedLayerRevision === undefined) {
      const state = await localDatabase.system.get(sharedLayerAvailabilityKey(workspace));
      if (state) {
        const activeSlots = new Set<string>(JSON.parse(state.value).activeSharedSlots);
        layers = layers.filter(layer => layer.kind !== "shared" || activeSlots.has(layer.sharedSlot!));
      }
    }
    const previous = await localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).toArray();
    layers = await reconcileAnnotationReadingPreferences(workspace, layers, previous, preferenceVersion);
    const ids = new Set(layers.map(layer => layer.id));
    const editable = new Set(layers.filter(layer => layer.canEdit).map(layer => layer.id));
    await localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey)
      .filter(annotation => annotation.syncErrorCode === "permission_denied" && editable.has(annotation.layerId))
      .modify({ state: "pending", syncErrorCode: null });
    if (layers.some(layer => !previous.some(entry => entry.id === layer.id))) {
      await localDatabase.annotationSyncCursors.delete(workspace.scopeKey);
    }
    const offlineRecords = (await localDatabase.offlineSnapshots.where("scopeKey").equals(workspace.scopeKey).toArray()).filter(hasValidSnapshotShape);
    const previousLayers = [...previous, ...offlineRecords.flatMap(record => record.annotationSnapshot.layers)];
    const revoked = new Set(previousLayers.filter(layer => layer.kind === "personal" && !layer.canEdit && !ids.has(layer.id)).map(layer => layer.id));
    await localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey)
      .filter(annotation => revoked.has(annotation.layerId)).delete();
    // Metadata is authoritative for every saved PDF version too. Keep paused shared
    // notes in the main annotation store, but snapshots contain only readable layers.
    for (const record of offlineRecords) {
      record.annotationSnapshot.layers = layers.filter(layer => record.annotationSnapshot.layers.some(saved => saved.id === layer.id)).map(layer => ({ ...layer,
        key: localWorkspaceRecordKey(workspace, layer.id), ...workspace }));
      record.annotationSnapshot.annotations = record.annotationSnapshot.annotations.filter(annotation => ids.has(annotation.layerId));
    }
    await diagnoseLocalOperation("sync-layers-snapshot", () => localDatabase.offlineSnapshots.bulkPut(offlineRecords));
    await localDatabase.annotationLayers.where("scopeKey").equals(workspace.scopeKey).delete();
    await localDatabase.annotationLayers.bulkPut(layers.map(layer => ({ ...layer,
      key: localWorkspaceRecordKey(workspace, layer.id), ...workspace })));
    return true;
  });
}

type SharedLayerAvailability = { sharedLayerRevision: number; activeSharedSlots: string[] };
const sharedLayerAvailabilityKey = (workspace: LocalWorkspace) => JSON.stringify(["shared-layer-state", workspace.ownerKey, workspace.choirId]);

export function applySharedLayerAvailability(workspace: LocalWorkspace, state: SharedLayerAvailability) {
  return withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.annotationLayers, localDatabase.offlineSnapshots],
    () => acceptSharedLayerAvailability(workspace, state));
}

// Runs in the caller's owner-fenced transaction, shared across all score locks
// and browser tabs. A stale response must not repopulate any score or snapshot.
async function acceptSharedLayerAvailability(workspace: LocalWorkspace, state: SharedLayerAvailability) {
  const key = sharedLayerAvailabilityKey(workspace);
  const previous = await localDatabase.system.get(key);
  if (previous && JSON.parse(previous.value).sharedLayerRevision > state.sharedLayerRevision) return false;
  await localDatabase.system.put({ key, value: JSON.stringify(state) });
  const activeSlots = new Set(state.activeSharedSlots);
  const driveLayers = await localDatabase.annotationLayers.where("ownerKey").equals(workspace.ownerKey)
    .filter(layer => layer.choirId === workspace.choirId && layer.kind === "shared" && !activeSlots.has(layer.sharedSlot!)).toArray();
  await localDatabase.annotationLayers.bulkDelete(driveLayers.map(layer => layer.key));
  const records = await localDatabase.offlineSnapshots.where("ownerKey").equals(workspace.ownerKey)
    .filter(record => record.choirId === workspace.choirId).toArray();
  const readableRecords = records.filter(hasValidSnapshotShape);
  for (const record of readableRecords) {
    record.annotationSnapshot.layers = record.annotationSnapshot.layers.filter(layer => layer.kind !== "shared" || activeSlots.has(layer.sharedSlot!));
    const readable = new Set(record.annotationSnapshot.layers.map(layer => layer.id));
    record.annotationSnapshot.annotations = record.annotationSnapshot.annotations.filter(annotation => readable.has(annotation.layerId));
  }
  await diagnoseLocalOperation("sync-layers-snapshot", () => localDatabase.offlineSnapshots.bulkPut(readableRecords));
  return true;
}

export async function removeCachedPublications(workspace: LocalWorkspace) {
  const layers = await readAnnotationLayers(workspace);
  await cacheAnnotationLayers(workspace, layers.filter(layer => layer.kind !== "personal" || layer.canEdit));
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
  if (isLocalExperience(workspace) && input.layerId !== GUEST_NOTE_LAYER_ID) throw new Error("guest_notes_are_local_only");
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
  if (isLocalExperience(workspace)) return 0;
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

export async function prepareAnnotationPush(workspace: LocalWorkspace, maxOperations: number, editableLayerIds?: ReadonlySet<string>) {
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
          .filter(operation => !editableLayerIds || editableLayerIds.has(operation.layerId))
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
  await withLocalWorkspaceTransaction(
    workspace,
    "rw",
    [
      localDatabase.offlineSnapshots,
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationSyncCursors,
    ],
    async () => {
      const saved = await localDatabase.offlineSnapshots.get(record.key);
      if (!saved || !hasValidSnapshotShape(saved)) return;
      const snapshot = saved.annotationSnapshot;
      for (const layer of snapshot.layers) annotationLayerSummarySchema.parse(layer);
      for (const annotation of snapshot.annotations) {
        if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
      }
      const availability = await localDatabase.system.get(sharedLayerAvailabilityKey(workspace));
      const activeSlots = availability ? new Set<string>(JSON.parse(availability.value).activeSharedSlots) : null;
      for (const layer of snapshot.layers) {
        if (layer.kind === "shared" && activeSlots && !activeSlots.has(layer.sharedSlot!)) continue;
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
