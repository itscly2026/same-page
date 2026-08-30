import { localDatabase } from "../platform/local-database";

export interface LogoutLocalSummary {
  pendingOperations: number;
  conflicts: number;
}

export async function getLogoutLocalSummary(): Promise<LogoutLocalSummary> {
  const [pendingOperations, conflicts] = await Promise.all([
    localDatabase.annotationOutbox.count(),
    localDatabase.annotationConflicts.count(),
  ]);
  return { pendingOperations, conflicts };
}

export async function clearPrivateLocalDataAfterLogout() {
  await localDatabase.transaction(
    "rw",
    [
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationOutbox,
      localDatabase.annotationConflicts,
      localDatabase.annotationSyncCursors,
      localDatabase.syncLeases,
      localDatabase.offlineScores,
    ],
    async () => {
      const layers = await localDatabase.annotationLayers.toArray();
      const personalLayerIds = new Set(
        layers.filter((layer) => layer.kind === "personal").map((layer) => layer.id),
      );
      const annotations = await localDatabase.annotations.toArray();
      await localDatabase.annotations.bulkDelete(
        annotations
          .filter(
            (annotation) =>
              personalLayerIds.has(annotation.layerId) ||
              annotation.state !== "synced",
          )
          .map((annotation) => annotation.key),
      );
      await localDatabase.annotationLayers.bulkDelete(
        layers
          .filter((layer) => layer.kind === "personal")
          .map((layer) => layer.key),
      );
      await localDatabase.annotationLayers.bulkUpdate(
        layers
          .filter((layer) => layer.kind === "shared")
          .map((layer) => ({
            key: layer.key,
            changes: {
              canEdit: false,
              colorOverride: null,
              visible: true,
            },
          })),
      );
      const offlineScores = await localDatabase.offlineScores.toArray();
      for (const score of offlineScores) {
        if (!score.annotationSnapshot) continue;
        const snapshotPersonalIds = new Set(
          score.annotationSnapshot.layers
            .filter((layer) => layer.kind === "personal")
            .map((layer) => layer.id),
        );
        await localDatabase.offlineScores.update(score.key, {
          annotationSnapshot: {
            ...score.annotationSnapshot,
            layers: score.annotationSnapshot.layers
              .filter((layer) => layer.kind === "shared")
              .map((layer) => ({
                ...layer,
                canEdit: false,
                colorOverride: null,
                visible: true,
              })),
            annotations: score.annotationSnapshot.annotations.filter(
              (annotation) =>
                !snapshotPersonalIds.has(annotation.layerId) &&
                annotation.state === "synced",
            ),
          },
        });
      }
      await Promise.all([
        localDatabase.annotationOutbox.clear(),
        localDatabase.annotationConflicts.clear(),
        localDatabase.annotationSyncCursors.clear(),
        localDatabase.syncLeases.clear(),
      ]);
    },
  );
}
