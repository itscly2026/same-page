import { beforeEach, describe, expect, it } from "vitest";

import {
  completeLoadingJourney,
  getLoadingPerformanceSnapshot,
  markLoadingMilestone,
  markRouteTransitionMilestones,
  resetLoadingPerformance,
  startLoadingJourney,
} from "./loading-performance";

describe("loading performance diagnostics", () => {
  beforeEach(() => resetLoadingPerformance());

  it("records a user journey through public milestones without identifiers", () => {
    startLoadingJourney("open-score", "cold");
    markLoadingMilestone("pdf-task-start");
    completeLoadingJourney("open-score", "first-canvas-visible");

    const snapshot = getLoadingPerformanceSnapshot();
    expect(snapshot.buildId).toEqual(expect.any(String));
    expect(snapshot.records.map((record) => record.name)).toEqual([
      "open-score:start",
      "pdf-task-start",
      "first-canvas-visible",
      "open-score:duration",
    ]);
    expect(snapshot.records[3]).toMatchObject({
      cacheCategory: "cold",
      journey: "open-score",
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/choirId|scoreId|email|cookie/i);
  });

  it("records the route commit for whichever loading journey is active", () => {
    startLoadingJourney("open-score", "cold");
    markRouteTransitionMilestones();

    expect(getLoadingPerformanceSnapshot().records).toContainEqual(
      expect.objectContaining({
        name: "route-transition-committed",
        journey: "open-score",
        cacheCategory: "cold",
      }),
    );
  });
});
