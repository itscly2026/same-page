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
  experienceOwnerKey,
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
  const owners = [ownerKey, experienceOwnerKey(ownerKey)];
  const [pendingOperations, conflicts, syncErrors, drafts] = await Promise.all([
    localDatabase.annotationOutbox.where("ownerKey").anyOf(owners).count(),
    localDatabase.annotationConflicts.where("ownerKey").anyOf(owners).count(),
    localDatabase.annotations
      .where("ownerKey")
      .anyOf(owners)
      .filter((annotation) => annotation.state === "sync-error")
      .count(),
    localDatabase.annotations.where("ownerKey").anyOf(owners).filter(annotation => annotation.state === "draft").count(),
  ]);
  return { pendingOperations: pendingOperations + drafts, conflicts, syncErrors };
}

export async function clearPrivateLocalDataAfterLogout() {
  const ownerKey = await currentLocalOwnerKey();
  if (!ownerKey?.startsWith("user:")) return;
  const experienceOwner = experienceOwnerKey(ownerKey);
  const owners = [ownerKey, experienceOwner];
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
      await localDatabase.system.filter(record => owners.some(owner => record.key.startsWith(JSON.stringify(["reading-defaults", owner]).slice(0, -1)) || record.key.startsWith(JSON.stringify(["reading-preference-version", owner]).slice(0, -1)))).delete();
      await localDatabase.readingPreferences.where("ownerKey").anyOf(owners).delete();
      await localDatabase.driveDirectories.where("ownerKey").anyOf(owners).delete();
      const offlineScores = await localDatabase.offlineScores
        .where("ownerKey")
        .anyOf(owners)
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
      // Experience belongs to this login session too; only the sanitized public
      // offline copies above survive logout, never local personal annotations.
      for (const table of [localDatabase.annotationLayers, localDatabase.annotations,
        localDatabase.annotationOutbox, localDatabase.annotationConflicts,
        localDatabase.annotationSyncCursors, localDatabase.syncLeases,
        localDatabase.offlineScores, localDatabase.offlineSnapshots]) {
        await table.where("ownerKey").equals(experienceOwner).delete();
      }
      await localDatabase.offlineScores.bulkDelete(offlineScores.map(score => score.key));
      await localDatabase.offlineSnapshots.bulkDelete(offlineScores.map(score => score.key));
      for (const score of nextOfflineScores) await storeOfflineScore(score);
    },
  );
  await clearCurrentAuthenticatedLocalOwner();
}
