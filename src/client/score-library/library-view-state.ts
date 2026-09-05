import { scoreFileNameKey } from "../../shared/scores";
import type { ScoreSummary } from "../../shared/scores";
import type { DriveCacheOwnerKey } from "./drive-library-cache";

export type LibrarySort = "name" | "updated" | "opened";
export interface LibraryView {
  search: string;
  sort: LibrarySort;
  scrollTop: number;
}

const prefix = "same-page:library-view:";
const recentPrefix = "same-page:recent-scores:";
const defaultView: LibraryView = { search: "", sort: "name", scrollTop: 0 };
const key = (owner: DriveCacheOwnerKey, choirId: string) => JSON.stringify([owner, choirId]);

export function readLibraryView(owner: DriveCacheOwnerKey, choirId: string): LibraryView {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(prefix + key(owner, choirId)) ?? "null");
    if (value && typeof value.search === "string" &&
      ["name", "updated", "opened"].includes(value.sort) &&
      Number.isFinite(value.scrollTop) && value.scrollTop >= 0) {
      return { search: value.search, sort: value.sort, scrollTop: value.scrollTop };
    }
  } catch { /* Storage is optional; navigation still works without it. */ }
  return { ...defaultView };
}

export function rememberLibraryView(owner: DriveCacheOwnerKey, choirId: string, view: LibraryView) {
  try {
    window.sessionStorage.setItem(prefix + key(owner, choirId), JSON.stringify(view));
  } catch { /* Optional device state. */ }
}

export function recordScoreOpened(owner: DriveCacheOwnerKey, choirId: string, scoreId: string) {
  const records = readRecentlyOpened(owner, choirId);
  records[scoreId] = Date.now();
  const bounded = Object.fromEntries(
    Object.entries(records).sort((a, b) => b[1] - a[1]).slice(0, 500),
  );
  try {
    window.localStorage.setItem(recentPrefix + key(owner, choirId), JSON.stringify(bounded));
  } catch { /* Optional device state. */ }
}

function readRecentlyOpened(owner: DriveCacheOwnerKey, choirId: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(recentPrefix + key(owner, choirId)) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ));
    }
  } catch { /* Optional device state. */ }
  return {};
}

export function selectLibraryScores(
  scores: ScoreSummary[], search: string, sort: LibrarySort,
  owner: DriveCacheOwnerKey, choirId: string,
) {
  const query = scoreFileNameKey(search.trim());
  const opened = sort === "opened" ? readRecentlyOpened(owner, choirId) : {};
  return scores
    .filter((score) => scoreFileNameKey(score.fileName).includes(query))
    .sort((a, b) => {
      const difference = sort === "updated" ? b.updatedAt - a.updatedAt
        : sort === "opened" ? (opened[b.id] ?? 0) - (opened[a.id] ?? 0) : 0;
      return difference || a.fileName.localeCompare(b.fileName, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);
    });
}

// A session becoming available after page reload is not logout: keep device state
// across that transition. Call this only after an explicit logout succeeds.
export function clearLibraryDeviceState() {
  for (const [storageName, ownedPrefix] of [
    ["sessionStorage", prefix], ["localStorage", recentPrefix],
  ] as const) {
    try {
      const storage = window[storageName];
      for (let index = storage.length - 1; index >= 0; index--) {
        const storageKey = storage.key(index);
        if (storageKey?.startsWith(ownedPrefix)) storage.removeItem(storageKey);
      }
    } catch { /* Storage can be unavailable in private browsing. */ }
  }
}
