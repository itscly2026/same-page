import { highlighterPasses } from "./highlighter-geometry";
import type { MultiPolygon, Pair } from "polygon-clipping";
import { getStroke } from "perfect-freehand";
import type { AnnotationPayload } from "../../shared/annotations";

type Ink = Extract<AnnotationPayload, { kind: "ink" }>;
// Freehand outlines can self-intersect; even-odd would punch out crossings.
// Clipped highlighter polygons explicitly contain holes and use even-odd.
export const inkFillRule = (ink: Pick<Ink, "brush">): CanvasFillRule => ink.brush === "pen" ? "nonzero" : "evenodd";

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
export function inkPaints(ink: Ink, width: number, height: number): MultiPolygon[] {
  if (ink.brush !== "highlighter") return [[[inkOutline(ink, width, height) as Pair[]]]];
  return highlighterPasses(ink, width / height).map(pass => pass.map(polygon => polygon.map(ring => ring.map(([x, y]) => [x * width, y * width] as Pair))));
}
export function inkSvgPaths(ink: Ink, aspectRatio: number): string[] {
  return inkPaints(ink, 1000, 1000 / aspectRatio).map(paint => paint.map(polygon => polygon.map(ring => `M${ring.map(([x,y]) => `${x},${y * aspectRatio}`).join("L")}Z`).join("")).join(""));
}
export function inkHit(ink: Ink, width: number, height: number, x: number, y: number, radius: number): boolean {
  return inkPaints(ink, width, height).some(paint => paint.some(polygon => {
    let inside = false;
    let winding = 0;
    for (const ring of polygon) {
      const hit = ringHit(ring, x, y, radius);
      if (hit.edge) return true;
      if (hit.inside) inside = !inside;
      winding += hit.winding;
    }
    return inkFillRule(ink) === "nonzero" ? winding !== 0 : inside;
  }));
}
function ringHit(polygon: Pair[], x: number, y: number, radius: number) {
  let inside = false;
  let winding = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j]!, [bx, by] = polygon[i]!;
    if ((ay! > y) !== (by! > y) && x < (bx! - ax!) * (y - ay!) / (by! - ay!) + ax!) inside = !inside;
    const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && side > 0) winding++;
    else if (ay > y && by <= y && side < 0) winding--;
    const dx = bx! - ax!, dy = by! - ay!;
    const t = Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(x - ax! - t * dx, y - ay! - t * dy) <= radius) return { inside, winding, edge: true };
  }
  return { inside, winding, edge: false };
}
