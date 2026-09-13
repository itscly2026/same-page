import { expect, it, vi } from "vitest";
import { regressionHighlighter } from "../../test/highlighter-fixture";
import { annotationPayloadSchema } from "../../shared/annotations";
import { highlighterPasses } from "./highlighter-geometry";
import { highlighterSamples } from "./highlighter-samples";
import { inkSvgPaths, inkPaints, inkHit, inkFillRule, inkRenderingDegraded } from "./ink-geometry";
import { clearDiagnostics, exportDiagnostics } from "../diagnostics/diagnostics";
import { createCoverageClipping } from "./coverage-clipping";

it("renders the minimal self-enclosing-ring regression without fallback or mutation", () => {
  const ink = regressionHighlighter(), before = structuredClone(ink), ratio = 820 / 1148;
  expect(annotationPayloadSchema.safeParse(ink).success).toBe(true);
  expect(highlighterPasses(ink, ratio).length).toBeGreaterThan(0);
  const paths = inkSvgPaths(ink, ratio);
  expect(paths.length).toBeGreaterThan(0);
  expect(inkRenderingDegraded(ink, ratio)).toBe(false);
  expect(inkSvgPaths(ink, ratio)).toBe(paths);
  expect(inkPaints(ink, 1000, 1400).flat(4).every(Number.isFinite)).toBe(true);
  expect(ink).toEqual(before);
});

it("retains pauses at a reversal and barrel rotation while simplifying dense lines", () => {
  const ink = regressionHighlighter();
  const points = [{x:.1,y:.5},{x:.9,y:.5},{x:.9,y:.5},{x:.9,y:.5},{x:.1,y:.5}];
  expect(highlighterSamples({...ink, points}, 1)).toEqual([points[0],points[1],points[4]]);
  const rotated = [{x:.1,y:.5,twist:0},{x:.1,y:.5,twist:30},{x:.1,y:.5,twist:90}];
  expect(highlighterSamples({...ink, points:rotated}, 1)).toEqual(rotated);
  const dense = Array.from({length:5000},(_,i)=>({x:.1+.8*i/4999,y:.5}));
  expect(highlighterSamples({...ink, points:dense}, 1)).toHaveLength(2);
});

it.each(["round", "chisel"] as const)("renders 5000 smooth %s samples within the bounded geometry budget", nib => {
  const ink = {...regressionHighlighter(), nib, points:Array.from({length:5000},(_,i)=>({x:.1+.8*i/4999,y:.5+Math.sin(i/4999*20)*.1}))};
  expect(highlighterPasses(ink, .714).length).toBeGreaterThan(0);
  expect(inkSvgPaths(ink,.714)).toBe(inkSvgPaths(ink,.714));
  expect(inkRenderingDegraded(ink,.714)).toBe(false);
});

it("preserves holes and islands across fixed precision clipping", () => {
  const square = (a:number,b:number): [number,number][] => [[a,a],[b,a],[b,b],[a,b]];
  const clipping=createCoverageClipping();
  const donut=clipping.difference([[square(0,1)]],[[square(.2,.8)]]);
  expect(donut).toHaveLength(1); expect(donut[0]).toHaveLength(2);
  const island=clipping.union(donut,[[square(.4,.6)]]);
  expect(island).toHaveLength(2);
  expect(clipping.intersection(donut,[[square(.4,.6)]])).toEqual([]);
});

it("isolates a geometry failure, shares the fallback across render/export/hit testing, and records no private data", async () => {
  clearDiagnostics();
  const module = await import("./highlighter-geometry");
  const spy = vi.spyOn(module, "highlighterPasses").mockImplementation(() => { throw new RangeError("secret score / private points"); });
  try {
    const ink = {...regressionHighlighter(), points:[{x:.1,y:.5},{x:.9,y:.5}]};
    expect(inkSvgPaths(ink,1).length).toBe(1);
    expect(inkFillRule(ink,1)).toBe("nonzero");
    expect(inkRenderingDegraded(ink,1)).toBe(true);
    expect(inkPaints(ink,1000,1000).length).toBe(1);
    expect(inkHit(ink,1000,1000,500,500,1)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const report=exportDiagnostics();
    expect(report).toContain('"annotation-geometry"'); expect(report).toContain('"RangeError"');
    expect(report).not.toMatch(/secret|private points|strokeWidth/);
  } finally { spy.mockRestore(); clearDiagnostics(); }
});

it("bounds pathological retracing and keeps its source intact when falling back", () => {
  clearDiagnostics();
  const ink = {...regressionHighlighter(), points:Array.from({length:5000},(_,i)=>({x:i%2 ? .8 : .2,y:.5}))};
  const original = structuredClone(ink);
  expect(inkSvgPaths(ink,1).length).toBeGreaterThan(0);
  expect(inkRenderingDegraded(ink,1)).toBe(true);
  expect(ink).toEqual(original);
  expect(inkSvgPaths(ink,1)).toBe(inkSvgPaths(ink,1));
  clearDiagnostics();
});
