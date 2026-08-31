import {
  annotationRecordKey,
  guestOwnerSystemKey,
  localDatabase,
} from "../platform/local-database";
import {
  clearCurrentAuthenticatedLocalOwner,
  createLocalWorkspace,
  currentLocalOwnerKey,
  localWorkspaceRecordKey,
  type LocalWorkspaceOwnerKey,
} from "../platform/local-workspace";

export interface LogoutLocalSummary {
  pendingOperations: number;
  conflicts: number;
  syncErrors: number;
}

export async function getLogoutLocalSummary(): Promise<LogoutLocalSummary> {
  const ownerKey = await currentLocalOwnerKey();
  if (!ownerKey?.startsWith("user:")) {
    return { pendingOperations: 0, conflicts: 0, syncErrors: 0 };
  }
  const [pendingOperations, conflicts, syncErrors] = await Promise.all([
    localDatabase.annotationOutbox.where("ownerKey").equals(ownerKey).count(),
    localDatabase.annotationConflicts.where("ownerKey").equals(ownerKey).count(),
    localDatabase.annotations
      .where("ownerKey")
      .equals(ownerKey)
      .filter((annotation) => annotation.state === "sync-error")
      .count(),
  ]);
  return { pendingOperations, conflicts, syncErrors };
}

export async function clearPrivateLocalDataAfterLogout() {
  const ownerKey = await currentLocalOwnerKey();
  if (!ownerKey?.startsWith("user:")) return;
  await localDatabase.transaction(
    "rw",
    [
      localDatabase.system,
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationOutbox,
      localDatabase.annotationConflicts,
      localDatabase.annotationSyncCursors,
      localDatabase.syncLeases,
      localDatabase.offlineScores,
    ],
    async () => {
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
      const offlineScores = await localDatabase.offlineScores
        .where("ownerKey")
        .equals(ownerKey)
        .toArray();
      const guestOwners = new Map<string, LocalWorkspaceOwnerKey>();
      const guestWorkspace = async (choirId: string, scoreId: string) => {
        let guestOwner = guestOwners.get(choirId);
        if (!guestOwner) {
          guestOwner = `guest:${crypto.randomUUID()}` as LocalWorkspaceOwnerKey;
          guestOwners.set(choirId, guestOwner);
          await localDatabase.system.put({
            key: guestOwnerSystemKey(choirId),
            value: guestOwner,
          });
        }
        return createLocalWorkspace(guestOwner, choirId, scoreId);
      };

      const nextLayers = await Promise.all(
        sharedLayers.map(async (layer) => {
          const workspace = await guestWorkspace(layer.choirId, layer.scoreId);
          return {
            ...layer,
            ...workspace,
            key: localWorkspaceRecordKey(workspace, layer.id),
            canEdit: false,
            colorOverride: null,
            visible: true,
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
      const nextOfflineScores = [];
      for (const score of offlineScores) {
        const workspace = await guestWorkspace(score.choirId, score.scoreId);
        const snapshotPersonalIds = new Set(
          score.annotationSnapshot.layers
            .filter((layer) => layer.kind === "personal")
            .map((layer) => layer.id),
        );
        const snapshotSharedIds = new Set(
          score.annotationSnapshot.layers
            .filter((layer) => layer.kind === "shared")
            .map((layer) => layer.id),
        );
        nextOfflineScores.push({
          ...score,
          ...workspace,
          key: localWorkspaceRecordKey(workspace, score.versionId),
          annotationSnapshot: {
            ...score.annotationSnapshot,
            layers: score.annotationSnapshot.layers
              .filter((layer) => layer.kind === "shared")
              .map((layer) => ({
                ...layer,
                ...workspace,
                key: localWorkspaceRecordKey(workspace, layer.id),
                canEdit: false,
                colorOverride: null,
                visible: true,
              })),
            annotations: score.annotationSnapshot.annotations.filter(
              (annotation) =>
                snapshotSharedIds.has(annotation.layerId) &&
                !snapshotPersonalIds.has(annotation.layerId) &&
                annotation.state === "synced",
            ).map((annotation) => ({
              ...annotation,
              ...workspace,
              key: annotationRecordKey(workspace.scopeKey, annotation.id),
            })),
          },
        });
      }
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
        localDatabase.offlineScores.bulkDelete(
          offlineScores.map((score) => score.key),
        ),
        localDatabase.annotationOutbox.bulkDelete(outbox),
        localDatabase.annotationConflicts.bulkDelete(conflicts),
        localDatabase.annotationSyncCursors.bulkDelete(cursors),
        localDatabase.syncLeases.bulkDelete(leases),
      ]);
      await Promise.all([
        localDatabase.annotationLayers.bulkPut(nextLayers),
        localDatabase.annotations.bulkPut(nextAnnotations),
        localDatabase.offlineScores.bulkPut(nextOfflineScores),
      ]);
    },
  );
  await clearCurrentAuthenticatedLocalOwner();
}
