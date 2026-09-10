import { localDatabase, guestOwnerSystemKey } from "../platform/local-database";
import { assertLocalWorkspaceActive, currentLocalOwnerKey, type LocalWorkspace, type LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import { offlineFileFenceKeys } from "./offline-file-fence";
export async function captureOfflineFileFence(workspace: LocalWorkspace) {
  return localDatabase.transaction("r", localDatabase.system, async () => {
    await assertLocalWorkspaceActive(workspace);
    return JSON.stringify((await localDatabase.system.bulkGet(offlineFileFenceKeys(workspace))).map(row => row?.value ?? ""));
  });
}
export async function listLocalFiles() {
  return localDatabase.transaction("r", [localDatabase.system, localDatabase.offlineScores, localDatabase.driveDirectories], async () => {
    const owner = await currentLocalOwnerKey();
    const directories = await localDatabase.driveDirectories.toArray();
    const files = (await localDatabase.offlineScores.toArray()).map(file => ({ ...file, driveName: directories.find(drive => drive.ownerKey === file.ownerKey.replace(/^experience:/, "") && drive.choirId === file.choirId)?.choir.name ?? "云盘" }));
    if (owner?.startsWith("user:")) return files.filter(file => file.ownerKey === owner || file.ownerKey === `experience:${owner}`);
    const guests = await localDatabase.system.bulkGet(files.map(file => guestOwnerSystemKey(file.choirId)));
    return files.filter((file, i) => file.ownerKey.startsWith("guest:") && guests[i]?.value === file.ownerKey);
  });
}
export type LocalFileScope = { ownerKey: LocalWorkspaceOwnerKey; choirId?: string; scoreId?: string };
export async function clearLocalFiles(scope: LocalFileScope) {
  return localDatabase.transaction("rw", [localDatabase.system, localDatabase.offlineScores, localDatabase.offlineSnapshots], async () => {
    const owner = await currentLocalOwnerKey();
    const baseOwnerKey = scope.ownerKey.replace(/^experience:/, "");
    if (baseOwnerKey.startsWith("user:") ? owner !== baseOwnerKey : owner?.startsWith("user:") || !scope.choirId || (await localDatabase.system.get(guestOwnerSystemKey(scope.choirId)))?.value !== scope.ownerKey) throw new Error("local_workspace_owner_changed");
    const key = JSON.stringify(["offline-files", scope.ownerKey, ...(scope.choirId ? [scope.choirId] : []), ...(scope.scoreId ? [scope.scoreId] : [])]);
    await localDatabase.system.put({ key, value: crypto.randomUUID() });
    const files = await localDatabase.offlineScores.where("ownerKey").equals(scope.ownerKey)
      .filter(file => (!scope.choirId || file.choirId === scope.choirId) && (!scope.scoreId || file.scoreId === scope.scoreId)).toArray();
    await localDatabase.offlineScores.bulkDelete(files.map(file => file.key));
    await localDatabase.offlineSnapshots.bulkDelete(files.map(file => file.key));
    return files.reduce((bytes, file) => bytes + file.blob.size, 0);
  });
}
