import {
  annotationLayerSummarySchema,
  annotationPayloadSchema,
} from "../../shared/annotations";
import {
  annotationScopeKey,
  localDatabase,
  type OfflineAnnotationSnapshot,
  type OfflineScoreRecord,
} from "../platform/local-database";

export async function captureOfflineAnnotationSnapshot(
  choirId: string,
  scoreId: string,
): Promise<OfflineAnnotationSnapshot> {
  const scopeKey = annotationScopeKey(choirId, scoreId);
  return localDatabase.transaction(
    "r",
    localDatabase.annotationLayers,
    localDatabase.annotations,
    localDatabase.annotationSyncCursors,
    async () => {
      const layers = await localDatabase.annotationLayers
        .where("scopeKey")
        .equals(scopeKey)
        .toArray();
      const annotations = await localDatabase.annotations
        .where("scopeKey")
        .equals(scopeKey)
        .toArray();
      for (const layer of layers) annotationLayerSummarySchema.parse(layer);
      for (const annotation of annotations) {
        if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
      }
      return {
        layers,
        annotations,
        cursor:
          (await localDatabase.annotationSyncCursors.get(scopeKey))?.cursor ?? 0,
        verifiedAt: Date.now(),
      };
    },
  );
}

export async function restoreOfflineAnnotationSnapshot(
  record: OfflineScoreRecord,
) {
  const snapshot = record.annotationSnapshot;
  if (!snapshot) return;
  for (const layer of snapshot.layers) annotationLayerSummarySchema.parse(layer);
  for (const annotation of snapshot.annotations) {
    if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
  }
  await localDatabase.transaction(
    "rw",
    localDatabase.annotationLayers,
    localDatabase.annotations,
    localDatabase.annotationSyncCursors,
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
      const scopeKey = annotationScopeKey(record.choirId, record.scoreId);
      if (!(await localDatabase.annotationSyncCursors.get(scopeKey))) {
        await localDatabase.annotationSyncCursors.put({
          scopeKey,
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
  const registration = await navigator.serviceWorker.ready;
  if (!registration.active) throw new Error("service_worker_not_active");
}
