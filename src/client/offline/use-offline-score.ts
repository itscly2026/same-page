import { useLiveQuery } from "dexie-react-hooks";
import { localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { isLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { inspectOfflineScore } from "./offline-score-verification";

export function useOfflineScore(workspace: LocalWorkspace | null) {
  return useLiveQuery(async (): Promise<{ scopeKey: string; record: OfflineScoreRecord | null; invalid: boolean } | null> => {
    if (!workspace) return null;
    try {
    if (!(await isLocalWorkspaceActive(workspace))) return null;
    // Track the scope in this live query even when the shared inspection was
    // started by a reader outside Dexie's observation context. No Blob is read.
    await localDatabase.offlineScores.where("[ownerKey+choirId+scoreId]")
      .equals([workspace.ownerKey, workspace.choirId, workspace.scoreId]).count();
    const result = await inspectOfflineScore(workspace);
    if (!(await isLocalWorkspaceActive(workspace))) return null;
    return { scopeKey: workspace.scopeKey, ...result };
    } catch {
      return { scopeKey: workspace.scopeKey, record: null, invalid: true };
    }
  }, [workspace?.scopeKey]);
}

export function offlineScoreLabel(record: OfflineScoreRecord | null, currentVersionId: string, invalid = false, mode?: "pdf" | "images") {
  if (invalid) return "本地副本不可用，请重新下载";
  if (!record) return "尚未下载离线副本";
  if (mode && (record.imageManifest ? "images" : "pdf") !== mode) return `当前显示方式尚未下载 · ${record.imageManifest ? "图片" : "PDF"}副本可离线使用`;
  return record.versionId === currentVersionId ? "可离线使用" : "旧版可离线使用 · 新版待下载";
}
