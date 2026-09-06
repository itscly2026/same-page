import type { LocalWorkspace } from "../platform/local-workspace";
export function offlineFileFenceKeys(workspace: Pick<LocalWorkspace, "ownerKey" | "choirId" | "scoreId">) {
  return [JSON.stringify(["offline-files", workspace.ownerKey]), JSON.stringify(["offline-files", workspace.ownerKey, workspace.choirId]), JSON.stringify(["offline-files", workspace.ownerKey, workspace.choirId, workspace.scoreId])];
}
