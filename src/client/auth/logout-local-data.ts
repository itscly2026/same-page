import { storeOfflineScore } from "../platform/local-database";
import { retainGuestSharedAnnotations } from "../annotations/annotation-state";
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
  const [pendingOperations, conflicts, syncErrors, drafts] = await Promise.all([
    localDatabase.annotationOutbox.where("ownerKey").equals(ownerKey).count(),
    localDatabase.annotationConflicts.where("ownerKey").equals(ownerKey).count(),
    localDatabase.annotations
      .where("ownerKey")
      .equals(ownerKey)
      .filter((annotation) => annotation.state === "sync-error")
      .count(),
    localDatabase.annotations.where("ownerKey").equals(ownerKey).filter(annotation => annotation.state === "draft").count(),
  ]);
  return { pendingOperations: pendingOperations + drafts, conflicts, syncErrors };
}

export async function clearPrivateLocalDataAfterLogout() {
  const ownerKey = await currentLocalOwnerKey();
  if (!ownerKey?.startsWith("user:")) return;
  await localDatabase.transaction(
    "rw",
    [
      localDatabase.system,
      localDatabase.driveDirectories,
      localDatabase.readingPreferences,
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationOutbox,
      localDatabase.annotationConflicts,
      localDatabase.annotationSyncCursors,
      localDatabase.syncLeases,
      localDatabase.offlineScores,
      localDatabase.offlineSnapshots,
    ],
    async () => {
      await localDatabase.system.filter(record => record.key.startsWith(JSON.stringify(["reading-defaults", ownerKey]).slice(0, -1)) || record.key.startsWith(JSON.stringify(["reading-preference-version", ownerKey]).slice(0, -1))).delete();
      await localDatabase.readingPreferences.where("ownerKey").equals(ownerKey).delete();
      await localDatabase.driveDirectories.where("ownerKey").equals(ownerKey).delete();
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

      const nextOfflineScores = [];
      for (const file of offlineScores) {
        const saved = await localDatabase.offlineSnapshots.get(file.key);
        if (!saved) continue;
        const score = { ...file, annotationSnapshot: saved.annotationSnapshot };
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
                scoreSubscriptionOverride: null,
                subscribed: true,
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
      await retainGuestSharedAnnotations(ownerKey, guestWorkspace);
      await localDatabase.offlineScores.bulkDelete(offlineScores.map(score => score.key));
      await localDatabase.offlineSnapshots.bulkDelete(offlineScores.map(score => score.key));
      for (const score of nextOfflineScores) await storeOfflineScore(score);
    },
  );
  await clearCurrentAuthenticatedLocalOwner();
}
