import { ramerDouglasPeuckerD, type PointD } from "clipper2-ts";
import type { AnnotationPayload } from "../../shared/annotations";

type Ink = Extract<AnnotationPayload, { kind: "ink" }>;
// At the export limit (4096px), this is under 0.5px. Stored points are untouched.
const tolerance = 1e-4;
export function highlighterSamples(ink: Ink, aspectRatio: number): Ink["points"] {
  const points = ink.points.filter((point, index, all) => {
    const previous = all[index - 1];
    return !previous || point.x !== previous.x || point.y !== previous.y
      || (ink.nib === "chisel" && (point.twist ?? 0) !== (previous.twist ?? 0));
  });
  if (points.length < 5) return points;
  const result: Ink["points"] = [];
  let start = 0;
  const flush = (end: number) => {
    const path = points.slice(start, end + 1).map(point => ({ x: point.x, y: point.y / aspectRatio, source: point }));
    const sources = new Map<PointD, Ink["points"][number]>(path.map(point => [point, point.source]));
    const simplified = ramerDouglasPeuckerD(path, tolerance).map(point => sources.get(point)!);
    result.push(...simplified.slice(result.length ? 1 : 0));
    start = end;
  };
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1]!, point = points[i]!, after = points[i + 1]!;
    // Collinear reversals deposit more ink: ordinary RDP alone erases them.
    const reversal = (point.x - before.x) * (after.x - point.x)
      + (point.y - before.y) * (after.y - point.y) / (aspectRatio * aspectRatio) < 0;
    const rotation = ink.nib === "chisel" && ((before.twist ?? 0) !== (point.twist ?? 0) || (after.twist ?? 0) !== (point.twist ?? 0));
    if (reversal || rotation) flush(i);
  }
  flush(points.length - 1);
  return result;
}
