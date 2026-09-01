import { describe, expect, it } from "vitest";

import {
  calculateFittedPageWidth,
  calculatePageTurnDistance,
} from "./reader-dimensions";

describe("calculateFittedPageWidth", () => {
  it("fits the paper to the full viewport without artificial reader gutters", () => {
    expect(calculateFittedPageWidth(1000, 800, 0.75)).toBe(600);
    expect(calculateFittedPageWidth(600, 1000, 0.75)).toBe(600);
  });
});

describe("calculatePageTurnDistance", () => {
  it("keeps the adjacent paper outside its centered clipping window", () => {
    const paperWidth = 707;
    const distance = calculatePageTurnDistance(paperWidth, 14);

    expect(distance).toBe(721);
    expect(distance).toBeGreaterThan(paperWidth);
  });
});
