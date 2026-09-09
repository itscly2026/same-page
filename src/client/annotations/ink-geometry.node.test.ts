import { describe, expect, it } from "vitest";
import { annotationPayloadSchema } from "../../shared/annotations";
import { inkHit, inkOutline, inkSvgPaths } from "./ink-geometry";
const stroke = { kind: "ink" as const, brush: "pen" as const, nib: "round" as const, pressureMode: "uniform" as const, pageNumber: 1, strokeWidth: .02, points: [{ x: .2, y: .5, pressure: .1 }, { x: .5, y: .5, pressure: .9 }, { x: .8, y: .5, pressure: .9 }] };
describe("ink geometry", () => {
  it("shares page geometry between SVG and export without stretching wide strokes", () => {
    const outline = inkOutline(stroke, 1000, 2000);
    expect(inkSvgPaths(stroke, .5)[0]).toBe(`M${outline.map(([x,y]) => `${x},${y!*.5}`).join("L")}Z`);
    expect(Math.max(...outline.map(p => p[1]!)) - Math.min(...outline.map(p => p[1]!))).toBeCloseTo(20, 0);
    expect(inkHit(stroke, 1000, 2000, 500, 1008, 0)).toBe(true);
    expect(inkHit(stroke, 1000, 2000, 500, 1020, 0)).toBe(false);
  });
  it("uses recorded pressure only for pressure pens and keeps highlighters uniform", () => {
    const pressure = { ...stroke, pressureMode: "pressure" as const };
    expect(inkOutline(pressure, 1000, 1000)).not.toEqual(inkOutline(stroke, 1000, 1000));
    expect(inkOutline({ ...pressure, brush: "highlighter" }, 1000, 1000)).toEqual(inkOutline(stroke, 1000, 1000));
  });
  it("requires explicit brush semantics and rejects unsafe style bounds", () => {
    expect(annotationPayloadSchema.safeParse(stroke).success).toBe(true);
    expect(annotationPayloadSchema.safeParse({ ...stroke, brush: undefined }).success).toBe(false);
    for (const strokeWidth of [0, -.1, Infinity, .061]) expect(annotationPayloadSchema.safeParse({ ...stroke, strokeWidth }).success).toBe(false);
  });
});
