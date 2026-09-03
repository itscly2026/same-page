import { describe, expect, it } from "vitest";

import {
  classifyPerformanceRequest,
  summarizeJourneySamples,
} from "./loading-performance-report.mjs";

describe("loading performance report", () => {
  it("uses one stable request vocabulary for controlled and production reports", () => {
    expect(classifyPerformanceRequest("/api/choirs/drive/bootstrap")).toBe("drive-bootstrap");
    expect(classifyPerformanceRequest("/api/choirs/drive/scores/score/bootstrap")).toBe("score-bootstrap");
    expect(classifyPerformanceRequest("/api/choirs/drive/scores")).toBe("score-list");
  });

  it("reports every sample and the median rather than the best run", () => {
    expect(summarizeJourneySamples([
      { journey: "open-score", cacheCategory: "cold", duration: 310 },
      { journey: "open-score", cacheCategory: "cold", duration: 180 },
      { journey: "open-score", cacheCategory: "cold", duration: 250 },
    ])).toEqual([{
      journey: "open-score",
      cacheCategory: "cold",
      samples: [310, 180, 250],
      median: 250,
    }]);
  });
});
