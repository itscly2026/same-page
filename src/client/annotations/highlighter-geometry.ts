import type { MultiPolygon, Pair } from "./coverage-clipping";
import { createCoverageClipping } from "./coverage-clipping";
import { highlighterSamples } from "./highlighter-samples";
import { polygonHull } from "d3-polygon";
import type { AnnotationPayload } from "../../shared/annotations";

type Ink = Extract<AnnotationPayload, { kind: "ink" }>;
type Point = Ink["points"][number];
type Pose = { x: number; y: number; angle: number; length: number; thickness: number };

export function highlighterPose(ink: Pick<Ink, "nib" | "strokeWidth">, point: Point, aspectRatio: number): Pose {
  // Barrel roll is independent of tilt. Browsers without roll report zero;
  // a stable diagonal is preferable to inventing rotation from azimuth noise.
  return {
    x: point.x, y: point.y / aspectRatio,
    angle: ink.nib === "round" ? 0 : Math.PI / 4 + (point.twist ?? 0) * Math.PI / 180,
    length: ink.strokeWidth,
    thickness: ink.strokeWidth * (ink.nib === "round" ? 1 : .22),
  };
}
function footprint(pose: Pose, round: boolean): Pair[] {
  const vertices: Pair[] = round
    ? Array.from({ length: 20 }, (_, index) => [Math.cos(index * Math.PI / 10) / 2, Math.sin(index * Math.PI / 10) / 2])
    : [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]];
  const cos = Math.cos(pose.angle), sin = Math.sin(pose.angle);
  return vertices.map(([x, y]) => [rounded(pose.x + x * pose.length * cos - y * pose.thickness * sin), rounded(pose.y + x * pose.length * sin + y * pose.thickness * cos)]);
}
const rounded = (value: number) => Math.round(value * 1e8) / 1e8;
const asMulti = (ring: Pair[]): MultiPolygon => [[ring]];

type State = { pose: Pose; nib: Pair[]; coats: MultiPolygon[] };
// Point identities survive NoteInteraction's immutable payload snapshots. Validate
// the simplified prefix before reuse: adding an endpoint may change simplification.
type Checkpoint = State & { work: number };
type Cached = { ratio: number; nib: Ink["nib"]; width: number; points: Ink["points"]; checkpoints: Checkpoint[]; failedAt?: number };
const cache = new WeakMap<Point, Cached>();
export function highlighterPasses(ink: Ink, aspectRatio: number): MultiPolygon[] {
  const points = highlighterSamples(ink, aspectRatio);
  const first = points[0];
  if (!first) return [];
  let cached = cache.get(first);
  if (!cached || cached.ratio !== aspectRatio || cached.nib !== ink.nib || cached.width !== ink.strokeWidth) {
    const pose = highlighterPose(ink, first, aspectRatio), nib = footprint(pose, ink.nib === "round");
    cached = { ratio: aspectRatio, nib: ink.nib, width: ink.strokeWidth, points: [first], checkpoints: [{ pose, nib, coats: [asMulti(nib)], work: 0 }] };
    cache.set(first, cached);
  }
  let common = 0;
  while (common < points.length && points[common] === cached.points[common]) common++;
  if (cached.failedAt !== undefined && common > cached.failedAt) throw new RangeError("ink_geometry_budget");
  const resume = Math.min(common, cached.checkpoints.length);
  cached.checkpoints.length = resume;
  cached.points = points;
  cached.failedAt = undefined;
  const checkpoint = cached.checkpoints[resume - 1]!;
  const clipping = createCoverageClipping(checkpoint.work);
  const state: State = { ...checkpoint, coats: [...checkpoint.coats] };
  for (let index = resume; index < points.length; index++) {
    try {
      const point = points[index]!, end = highlighterPose(ink, point, aspectRatio), start = state.pose;
      // A flat nib has 180-degree symmetry. Interpolate a rotation so low-rate
      // pen events do not replace the swept footprint with a large bounding box.
      const delta = Math.atan2(Math.sin(2 * (end.angle - start.angle)), Math.cos(2 * (end.angle - start.angle))) / 2;
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const pose = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, angle: start.angle + delta * t, length: start.length + (end.length - start.length) * t, thickness: start.thickness + (end.thickness - start.thickness) * t };
        const nib = footprint(pose, ink.nib === "round");
        const hull = polygonHull([...state.nib, ...nib])!;
        // Only newly entered contact area deposits ink. Adjacent samples share
        // the preceding nib, so density and pauses add no coat; returning after
        // leaving an area does. Each nested region represents one opacity pass.
        let deposit = clipping.difference(asMulti(hull), asMulti(state.nib));
        for (let coat = 0; deposit.length; coat++) {
          const previous = state.coats[coat];
          if (!previous) { state.coats.push(deposit); break; }
          const overlap = clipping.intersection(previous, deposit);
          state.coats[coat] = clipping.union(previous, deposit);
          deposit = overlap;
        }
        state.nib = nib;
      }
      state.pose = end;
      cached.checkpoints.push({ ...state, coats: [...state.coats], work: clipping.work });
    } catch (error) {
      cached.failedAt = index;
      throw error;
    }
  }
  return state.coats;
}
export function highlighterNibPath(ink: Pick<Ink, "nib" | "strokeWidth">, point: Point, aspectRatio: number): string {
  const nib = footprint(highlighterPose(ink, point, aspectRatio), ink.nib === "round");
  return `M${nib.map(([x, y]) => `${x * 1000},${y * 1000 * aspectRatio}`).join("L")}Z`;
}
