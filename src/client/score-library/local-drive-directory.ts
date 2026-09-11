import { noCapabilities, type DriveCapabilities } from "../../shared/drive-permissions";
import type { ChoirSummary } from "../../shared/choirs";
import type { ScoreSummary } from "../../shared/scores";
import { localDatabase } from "../platform/local-database";
import { withLocalWorkspaceTransaction, type LocalWorkspace } from "../platform/local-workspace";

export async function rememberLocalDriveDirectory(workspace: LocalWorkspace, choir: ChoirSummary, scores: ScoreSummary[], signal: AbortSignal, membership = false, capabilities: DriveCapabilities = noCapabilities(), storage?: { usedBytes: number; limitBytes: number }) {
  // Capture the workspace epoch before fetching. Even A → B → A cannot commit an old directory.
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    await localDatabase.driveDirectories.put({ key: JSON.stringify([workspace.ownerKey, choir.id]), ownerKey: workspace.ownerKey, choirId: choir.id, choir, scores, membership, capabilities, storage });
  });
}

export async function readLocalDriveDirectories(userId: string) {
  const { authenticatedLocalOwnerKey, currentLocalOwnerKey } = await import("../platform/local-workspace");
  const ownerKey = authenticatedLocalOwnerKey(userId);
  return localDatabase.transaction("r", [localDatabase.system, localDatabase.driveDirectories, localDatabase.offlineScores], async () => {
    if (await currentLocalOwnerKey() !== ownerKey) return [];
    const directories = await localDatabase.driveDirectories.where("ownerKey").equals(ownerKey).toArray();
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

export async function removeLocalDriveScore(workspace: LocalWorkspace, scoreId: string, signal: AbortSignal) {
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    const key = JSON.stringify([workspace.ownerKey, workspace.choirId]);
    const directory = await localDatabase.driveDirectories.get(key);
    if (directory) await localDatabase.driveDirectories.put({ ...directory, scores: directory.scores.filter(score => score.id !== scoreId) });
  });
}

export async function rememberDriveAccessRevoked(workspace: LocalWorkspace, signal: AbortSignal) {
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    const key = JSON.stringify([workspace.ownerKey, workspace.choirId]);
    const directory = await localDatabase.driveDirectories.get(key);
    await localDatabase.driveDirectories.put({ key, ownerKey: workspace.ownerKey, choirId: workspace.choirId,
      choir: directory?.choir ?? { id: workspace.choirId, name: "云盘", guestAdmissionMode: "invite" },
      scores: [], membership: false, capabilities: noCapabilities(), accessRevoked: true });
  });
}

export async function renameLocalDriveScore(workspace: LocalWorkspace, scoreId: string, fileName: string, signal: AbortSignal) {
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    const key = JSON.stringify([workspace.ownerKey, workspace.choirId]);
    const directory = await localDatabase.driveDirectories.get(key);
    if (directory) await localDatabase.driveDirectories.put({ ...directory, scores: directory.scores.map(score => score.id === scoreId ? { ...score, fileName } : score) });
  });
}
