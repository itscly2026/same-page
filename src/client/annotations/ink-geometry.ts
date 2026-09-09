import { getStroke } from "perfect-freehand";
import type { AnnotationPayload } from "../../shared/annotations";

type Ink = Extract<AnnotationPayload, { kind: "ink" }>;
// Compute in page coordinates, never in a stretched square: width is relative
// to the page width, while points have independent normalized x/y axes.
export function inkOutline(ink: Ink, width: number, height: number): number[][] {
  return getStroke(ink.points.map(point => [point.x * width, point.y * height, point.pressure ?? 0.5]), {
    size: ink.strokeWidth * width,
    thinning: ink.brush === "pen" && ink.pressureMode === "pressure" ? 0.5 : 0,
    simulatePressure: false,
    smoothing: 0.5,
    streamline: 0.3,
    last: true,
  });
}
export function inkSvgPath(ink: Ink, aspectRatio: number): string {
  const points = inkOutline(ink, 1000, 1000 / aspectRatio);
  return points.length ? `M${points.map(([x, y]) => `${x},${y! * aspectRatio}`).join("L")}Z` : "";
}
export function inkHit(ink: Ink, width: number, height: number, x: number, y: number, radius: number): boolean {
  const polygon = inkOutline(ink, width, height);
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j]!, [bx, by] = polygon[i]!;
    if ((ay! > y) !== (by! > y) && x < (bx! - ax!) * (y - ay!) / (by! - ay!) + ax!) inside = !inside;
    const dx = bx! - ax!, dy = by! - ay!;
    const t = Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(x - ax! - t * dx, y - ay! - t * dy) <= radius) return true;
  }
  return inside;
}
