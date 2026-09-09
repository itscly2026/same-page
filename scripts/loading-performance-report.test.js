import { describe, expect, it } from "vitest";

import { summarizeJourneySamples } from "./loading-performance-report.mjs";

describe("loading performance report", () => {
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
