import type { ScoreSummary } from "../../shared/scores";
import { localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, createLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";
import { inspectOfflineScore } from "./offline-score-verification";

export function offlineScoreSummary(record: OfflineScoreRecord): ScoreSummary {
  return { id: record.scoreId, choirId: record.choirId, fileName: record.fileName, updatedAt: record.verifiedAt, currentVersion: { id: record.versionId, versionNumber: 1, sizeBytes: record.blob.size, sha256: record.imageManifest?.sourceSha256 ?? record.sha256, etag: "offline", pageCount: record.pageCount, createdAt: record.verifiedAt } };
}

export async function readRetainedScores(workspace: LocalWorkspace): Promise<ScoreSummary[]> {
  await assertLocalWorkspaceActive(workspace);
  const candidates = await localDatabase.offlineScores.where("ownerKey")
    .equals(workspace.ownerKey).filter(record => record.choirId === workspace.choirId).toArray();
  const scores = await Promise.all([...new Set(candidates.map(record => record.scoreId))].map(async scoreId => {
    const scope = { ...createLocalWorkspace(workspace.ownerKey, workspace.choirId, scoreId), sessionEpoch: workspace.sessionEpoch };
    const { record } = await inspectOfflineScore(scope).catch(() => ({ record: null }));
    return record ? offlineScoreSummary(record) : null;
  }));
  await assertLocalWorkspaceActive(workspace);
  return scores.filter(score => score !== null);
}
