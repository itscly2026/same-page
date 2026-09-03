import { onReaderIdentityChange } from "./reader-cache-events";

const MAX_RECENT_SCORES = 20;
const openedScores = new Map<string, true>();
const warmedIdentities = new Set<string>();

onReaderIdentityChange(() => {
  openedScores.clear();
  warmedIdentities.clear();
});

export function classifyReaderOpen(
  identity: string,
  choirId: string,
  scoreId: string,
) {
  const key = JSON.stringify([identity, choirId, scoreId]);
  const category = openedScores.has(key)
    ? "reopen" as const
    : warmedIdentities.has(identity)
      ? "warm" as const
      : "cold" as const;
  warmedIdentities.add(identity);
  openedScores.delete(key);
  openedScores.set(key, true);
  while (openedScores.size > MAX_RECENT_SCORES) {
    const oldest = openedScores.keys().next().value;
    if (oldest === undefined) break;
    openedScores.delete(oldest);
  }
  return category;
}
