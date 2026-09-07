import { useEffect, useRef, useState } from "react";
import type { ScoreSummary } from "../../shared/scores";
import { OfflinePreparation, type OfflinePreparationState } from "./offline-score";
import { useLiveQuery } from "dexie-react-hooks";
import { localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { createLocalWorkspace, isLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
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

export function useOfflinePreparation(workspace: LocalWorkspace | null, score: ScoreSummary, authenticatedUserId: string | null, sessionId: string | null) {
  const ownerKey = workspace?.ownerKey;
  const key = JSON.stringify([workspace?.scopeKey, score.currentVersion.id, authenticatedUserId, sessionId]);
  const current = useRef<OfflinePreparation | null>(null);
  const [observed, setObserved] = useState<{ key: string; state: OfflinePreparationState } | null>(null);
  useEffect(() => {
    if (!ownerKey) return;
    const preparation = new OfflinePreparation(createLocalWorkspace(ownerKey, score.choirId, score.id), score, "pdf", authenticatedUserId);
    current.current = preparation;
    const unsubscribe = preparation.subscribe(() => setObserved({ key, state: preparation.getSnapshot() }));
    return () => { unsubscribe(); preparation.dispose(); current.current = null; };
  }, [ownerKey, score, authenticatedUserId, key]);
  return { state: observed?.key === key ? observed.state : { phase: "idle" } as OfflinePreparationState,
    prepare: () => current.current?.prepare("explicit") };
}
