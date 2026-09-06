import type { ChoirSummary } from "../../shared/choirs";
import type { ScoreSummary } from "../../shared/scores";
import { localDatabase } from "../platform/local-database";
import { withLocalWorkspaceTransaction, type LocalWorkspace } from "../platform/local-workspace";

export async function rememberLocalDriveDirectory(workspace: LocalWorkspace, choir: ChoirSummary, scores: ScoreSummary[], signal: AbortSignal) {
  // Capture the workspace epoch before fetching. Even A → B → A cannot commit an old directory.
  await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.driveDirectories], async () => {
    signal.throwIfAborted();
    await localDatabase.driveDirectories.put({ key: JSON.stringify([workspace.ownerKey, choir.id]), ownerKey: workspace.ownerKey, choirId: choir.id, choir, scores });
  });
}
