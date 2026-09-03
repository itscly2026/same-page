import { expect, test } from "vitest";

import { evaluateLoadingBudget } from "./loading-performance-budget.mjs";

test("controlled delay crosses the regression budget and fails", () => {
  expect(
    evaluateLoadingBudget(
      [
        { journey: "enter-drive", duration: 220 },
        { journey: "open-score", duration: 480 },
        { journey: "exit-score", duration: 180 },
      ],
      { "enter-drive": 200, "open-score": 500, "exit-score": 200 },
    ),
  ).toEqual([{ journey: "enter-drive", duration: 220, budget: 200 }]);
});
