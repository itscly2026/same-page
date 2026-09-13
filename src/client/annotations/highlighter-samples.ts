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
    const keep = new Set([start, end]);
    const pending = [[start, end]];
    while (pending.length) {
      const [left, right] = pending.pop()!;
      const a = points[left!]!, b = points[right!]!;
      const dx = b.x - a.x, dy = (b.y - a.y) / aspectRatio;
      let farthest = -1, distance = tolerance * tolerance;
      for (let i = left! + 1; i < right!; i++) {
        const px = points[i]!.x - a.x, py = (points[i]!.y - a.y) / aspectRatio;
        // Clamp to the segment: a smooth U-turn can extend beyond either endpoint.
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
        const squared = (px - t * dx) ** 2 + (py - t * dy) ** 2;
        if (squared > distance) { distance = squared; farthest = i; }
      }
      if (farthest >= 0) { keep.add(farthest); pending.push([left!, farthest], [farthest, right!]); }
    }
    const simplified = [...keep].sort((a, b) => a - b).map(i => points[i]!);
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
