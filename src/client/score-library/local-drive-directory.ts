import type { ChoirSummary } from "../../shared/choirs";
import type { ScoreSummary } from "../../shared/scores";
import { localDatabase } from "../platform/local-database";
import { withLocalWorkspaceTransaction, type LocalWorkspace } from "../platform/local-workspace";

export async function rememberLocalDriveDirectory(workspace: LocalWorkspace, choir: ChoirSummary, scores: ScoreSummary[], signal: AbortSignal, membership = false, canManage = false, storage?: { usedBytes: number; limitBytes: number }) {
  // Capture the workspace epoch before fetching. Even A → B → A cannot commit an old directory.
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    await localDatabase.driveDirectories.put({ key: JSON.stringify([workspace.ownerKey, choir.id]), ownerKey: workspace.ownerKey, choirId: choir.id, choir, scores, membership, canManage, storage });
  });
}

export async function readLocalDriveDirectories(userId: string) {
  const { authenticatedLocalOwnerKey, currentLocalOwnerKey } = await import("../platform/local-workspace");
  const ownerKey = authenticatedLocalOwnerKey(userId);
  return localDatabase.transaction("r", [localDatabase.system, localDatabase.driveDirectories, localDatabase.offlineScores], async () => {
    if (await currentLocalOwnerKey() !== ownerKey) return [];
    const directories = await localDatabase.driveDirectories.where("ownerKey").equals(ownerKey).toArray();
    const copies = await localDatabase.offlineScores.where("ownerKey").equals(ownerKey).filter(record => record.active === 1).toArray();
    for (const copy of copies) {
      let directory = directories.find(entry => entry.choirId === copy.choirId);
      if (!directory) {
        directory = { key: JSON.stringify([ownerKey, copy.choirId]), ownerKey, choirId: copy.choirId, choir: { id: copy.choirId, name: "已保存的云盘", guestAdmissionMode: "invite" }, scores: [] };
        directories.push(directory);
      }
      if (!directory.scores.some(score => score.id === copy.scoreId)) directory.scores.push({ id: copy.scoreId, choirId: copy.choirId, fileName: copy.fileName, updatedAt: copy.verifiedAt,
        currentVersion: { id: copy.versionId, versionNumber: 1, sizeBytes: copy.blob.size, sha256: copy.sha256, etag: "offline", pageCount: copy.pageCount, createdAt: copy.verifiedAt } });
    }
    return directories;
  });
}

export async function renameLocalDriveDirectory(workspace: LocalWorkspace, name: string, signal: AbortSignal) {
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    const key = JSON.stringify([workspace.ownerKey, workspace.choirId]);
    const directory = await localDatabase.driveDirectories.get(key);
    if (directory) await localDatabase.driveDirectories.put({ ...directory, choir: { ...directory.choir, name } });
  });
}
