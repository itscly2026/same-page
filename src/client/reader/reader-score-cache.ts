import type { ScoreSummary } from "../../shared/scores";
import { onReaderIdentityChange } from "./reader-cache-events";

const summaries = new Map<string, ScoreSummary>();

onReaderIdentityChange(clearReaderScoreCache);

export function rememberReaderScore(identity: string, score: ScoreSummary) {
  summaries.set(cacheKey(identity, score.choirId, score.id), score);
}

export function peekReaderScore(
  identity: string,
  choirId: string,
  scoreId: string,
) {
  return summaries.get(cacheKey(identity, choirId, scoreId)) ?? null;
}

export function forgetReaderScore(
  identity: string,
  choirId: string,
  scoreId: string,
) {
  summaries.delete(cacheKey(identity, choirId, scoreId));
}

export function clearReaderScoreCache() {
  summaries.clear();
}

function cacheKey(identity: string, choirId: string, scoreId: string) {
  return JSON.stringify([identity, choirId, scoreId]);
}
