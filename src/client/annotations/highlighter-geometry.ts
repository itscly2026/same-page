import clipping, { type MultiPolygon, type Pair } from "polygon-clipping";
import { polygonArea, polygonHull } from "d3-polygon";
import type { AnnotationPayload } from "../../shared/annotations";

type Ink = Extract<AnnotationPayload, { kind: "ink" }>;
type Point = Ink["points"][number];
type Pose = { x: number; y: number; angle: number; length: number; thickness: number };

export function highlighterPose(ink: Pick<Ink, "nib" | "strokeWidth">, point: Point, aspectRatio: number): Pose {
  const tx = Math.tan(Math.max(-89.9, Math.min(89.9, point.tiltX ?? 0)) * Math.PI / 180);
  const ty = Math.tan(Math.max(-89.9, Math.min(89.9, point.tiltY ?? 0)) * Math.PI / 180);
  const tilt = Math.hypot(tx, ty);
  // Near vertical, azimuth is undefined. Use the same stable diagonal as mouse
  // input instead of letting sensor noise spin the nib.
  const direction = tilt > .15 ? Math.atan2(ty, tx) + Math.PI / 2 : -Math.PI / 4;
  return {
    x: point.x, y: point.y / aspectRatio,
    angle: ink.nib === "round" ? 0 : direction + (point.twist ?? 0) * Math.PI / 180,
    length: ink.strokeWidth * (ink.nib === "round" ? 1 : 1 + .5 * (1 - 1 / Math.sqrt(1 + tilt * tilt))),
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
const area = (geometry: MultiPolygon) => geometry.reduce((sum, polygon) => sum + polygon.reduce((total, ring, index) => total + Math.abs(polygonArea(ring)) * (index ? -1 : 1), 0), 0);

type State = { key: string; count: number; last: Point; pose: Pose; nib: Pair[]; finished: MultiPolygon[]; current: MultiPolygon };
// Retain only the most recent prefix per stroke. React's live snapshots share
// immutable point objects; completed/edited snapshots naturally invalidate it.
const cache = new WeakMap<Point, State>();
export function highlighterPasses(ink: Ink, aspectRatio: number): MultiPolygon[] {
  const first = ink.points[0];
  if (!first) return [];
  const key = `${aspectRatio}:${ink.nib}:${ink.strokeWidth}`;
  const cached = cache.get(first);
  let state: State;
  if (cached?.key === key && cached.count <= ink.points.length && cached.last === ink.points[cached.count - 1]) {
    state = { ...cached, finished: [...cached.finished] };
  } else {
    const pose = highlighterPose(ink, first, aspectRatio), nib = footprint(pose, ink.nib === "round");
    state = { key, count: 1, last: first, pose, nib, finished: [], current: asMulti(nib) };
  }
  for (let index = state.count; index < ink.points.length; index++) {
    const point = ink.points[index]!, end = highlighterPose(ink, point, aspectRatio), start = state.pose;
    // A flat nib has 180-degree symmetry. Interpolate a rotation so low-rate
    // pen events do not replace the swept footprint with a large bounding box.
    const delta = Math.atan2(Math.sin(2 * (end.angle - start.angle)), Math.cos(2 * (end.angle - start.angle))) / 2;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const pose = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, angle: start.angle + delta * t, length: start.length + (end.length - start.length) * t, thickness: start.thickness + (end.thickness - start.thickness) * t };
      const nib = footprint(pose, ink.nib === "round");
      const hull = polygonHull([...state.nib, ...nib])!;
      // Deposit only newly contacted area: adjacent samples must not get darker
      // merely because a device sends more events or the pen pauses.
      const deposit = clipping.difference(asMulti(hull), asMulti(state.nib));
      if (area(deposit) > 1e-12) {
        if (area(clipping.intersection(state.current, deposit)) > 1e-12) {
          state.finished.push(state.current);
          state.current = deposit;
        } else state.current = clipping.union(state.current, deposit);
      }
      state.nib = nib;
    }
    state.pose = end;
    state.count = index + 1;
    state.last = point;
  }
  cache.set(first, state);
  return [...state.finished, state.current];
}
export function highlighterNibPath(ink: Pick<Ink, "nib" | "strokeWidth">, point: Point, aspectRatio: number): string {
  const nib = footprint(highlighterPose(ink, point, aspectRatio), ink.nib === "round");
  return `M${nib.map(([x, y]) => `${x * 1000},${y * 1000 * aspectRatio}`).join("L")}Z`;
}
