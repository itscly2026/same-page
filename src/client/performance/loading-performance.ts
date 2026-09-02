import { buildId } from "../../shared/build";

export type LoadingJourney = "enter-drive" | "open-score" | "exit-score";
export type LoadingCacheCategory =
  | "cold"
  | "warm"
  | "reopen"
  | "direct"
  | "failure";

export interface LoadingPerformanceRecord {
  name: string;
  startTime: number;
  duration?: number;
  journey?: LoadingJourney;
  cacheCategory?: LoadingCacheCategory;
}

export interface LoadingPerformanceSnapshot {
  buildId: string;
  displayMode: "browser" | "standalone";
  serviceWorker: "unsupported" | "uncontrolled" | ServiceWorkerState;
  records: LoadingPerformanceRecord[];
}

const records: LoadingPerformanceRecord[] = [];
const activeJourneys = new Map<
  LoadingJourney,
  { cacheCategory: LoadingCacheCategory; startTime: number }
>();
const MAX_RECORDS = 100;

export function startLoadingJourney(
  journey: LoadingJourney,
  cacheCategory: LoadingCacheCategory,
) {
  const startTime = now();
  activeJourneys.set(journey, { cacheCategory, startTime });
  record({
    name: `${journey}:start`,
    startTime,
    journey,
    cacheCategory,
  });
  mark(`${journey}:start`);
}

export function ensureLoadingJourney(
  journey: LoadingJourney,
  cacheCategory: LoadingCacheCategory,
) {
  if (!activeJourneys.has(journey)) startLoadingJourney(journey, cacheCategory);
}

export function markLoadingMilestone(name: string) {
  const entry = { name, startTime: now() };
  record(entry);
  mark(name);
}

export function markLoadingJourneyMilestone(
  journey: LoadingJourney,
  name: string,
) {
  if (activeJourneys.has(journey)) markLoadingMilestone(name);
}

export function isLoadingJourneyActive(journey: LoadingJourney) {
  return activeJourneys.has(journey);
}

export function completeLoadingJourney(
  journey: LoadingJourney,
  milestone: string,
) {
  const active = activeJourneys.get(journey);
  if (!active) return;
  const completedAt = now();
  markLoadingMilestone(milestone);
  activeJourneys.delete(journey);
  const duration = Math.max(0, completedAt - active.startTime);
  record({
    name: `${journey}:duration`,
    startTime: active.startTime,
    duration,
    journey,
    cacheCategory: active.cacheCategory,
  });
  measure(`${journey}:duration`, `${journey}:start`, milestone);
}

export function getLoadingPerformanceSnapshot(): LoadingPerformanceSnapshot {
  const standalone = typeof window !== "undefined"
    && window.matchMedia?.("(display-mode: standalone)").matches;
  const controller = typeof navigator !== "undefined"
    && "serviceWorker" in navigator
    ? navigator.serviceWorker.controller
    : null;
  return {
    buildId,
    displayMode: standalone ? "standalone" : "browser",
    serviceWorker: typeof navigator === "undefined" || !("serviceWorker" in navigator)
      ? "unsupported"
      : controller?.state ?? "uncontrolled",
    records: records.map((entry) => ({ ...entry })),
  };
}

export function resetLoadingPerformance() {
  records.length = 0;
  activeJourneys.clear();
  if (typeof performance === "undefined") return;
  for (const entry of performance.getEntriesByName?.("same-page:enter-drive:start") ?? []) {
    performance.clearMarks(entry.name);
  }
}

function record(entry: LoadingPerformanceRecord) {
  records.push(entry);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("same-page:loading-performance", {
      detail: { ...entry },
    }));
  }
}

function mark(name: string) {
  try {
    performance.mark(`same-page:${name}`);
  } catch {
    // Performance marks are optional diagnostics and must not affect navigation.
  }
}

function measure(name: string, start: string, end: string) {
  try {
    performance.measure(
      `same-page:${name}`,
      `same-page:${start}`,
      `same-page:${end}`,
    );
  } catch {
    // A missing mark must not affect the user-facing path.
  }
}

function now() {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
