import {
  annotationLayerSummarySchema,
  annotationPayloadSchema,
} from "../../shared/annotations";
import {
  localDatabase,
  type OfflineAnnotationSnapshot,
  type OfflineScoreRecord,
} from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  type LocalWorkspace,
  withLocalWorkspaceTransaction,
} from "../platform/local-workspace";

export async function captureOfflineAnnotationSnapshot(
  workspace: LocalWorkspace,
): Promise<OfflineAnnotationSnapshot> {
  await assertLocalWorkspaceActive(workspace);
  return withLocalWorkspaceTransaction(
    workspace,
    "r",
    [
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationSyncCursors,
    ],
    async () => {
      const layers = await localDatabase.annotationLayers
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .toArray();
      const annotations = await localDatabase.annotations
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .toArray();
      for (const layer of layers) annotationLayerSummarySchema.parse(layer);
      for (const annotation of annotations) {
        if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
      }
      return {
        layers,
        annotations,
        cursor:
          (await localDatabase.annotationSyncCursors.get(workspace.scopeKey))
            ?.cursor ?? 0,
        verifiedAt: Date.now(),
      };
    },
  );
}

export async function restoreOfflineAnnotationSnapshot(
  workspace: LocalWorkspace,
  record: OfflineScoreRecord,
) {
  await assertLocalWorkspaceActive(workspace);
  if (record.scopeKey !== workspace.scopeKey) return;
  const snapshot = record.annotationSnapshot;
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
        if (!(await localDatabase.annotationLayers.get(layer.key))) {
          await localDatabase.annotationLayers.put(layer);
        }
      }
      for (const annotation of snapshot.annotations) {
        if (!(await localDatabase.annotations.get(annotation.key))) {
          await localDatabase.annotations.put(annotation);
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

export async function ensureOfflineAppShell() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("service_worker_unavailable");
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error("service_worker_not_registered");
  if (!registration.active) throw new Error("service_worker_not_active");
}
