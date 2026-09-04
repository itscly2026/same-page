import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { isLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { verifyOfflineScore } from "./offline-score-verification";

export function useOfflineScore(workspace: LocalWorkspace | null) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return useLiveQuery(async (): Promise<{ scopeKey: string; record: OfflineScoreRecord | null; invalid: boolean } | null> => {
    if (!workspace) return null;
    try {
    if (!(await isLocalWorkspaceActive(workspace))) return null;
    const record = await localDatabase.offlineScores.where("[ownerKey+choirId+scoreId]")
      .equals([workspace.ownerKey, workspace.choirId, workspace.scoreId]).filter((entry) => entry.active === 1).first();
    const valid = record ? await verifyOfflineScore(record) : false;
    if (!(await isLocalWorkspaceActive(workspace))) return null;
    return { scopeKey: workspace.scopeKey, record: valid ? record ?? null : null, invalid: Boolean(record && !valid) };
    } catch {
      return { scopeKey: workspace.scopeKey, record: null, invalid: true };
    }
  }, [workspace?.scopeKey, revision]);
}

export function offlineScoreLabel(record: OfflineScoreRecord | null, currentVersionId: string, invalid = false) {
  if (invalid) return "本地副本不可用，请重新下载";
  if (!record) return "尚未下载离线副本";
  return record.versionId === currentVersionId ? "可离线使用" : "旧版可离线使用 · 新版待下载";
}
