import { booleanOpDWithPolyTree, ClipType, FillRule, PolyTreeD, type PolyPathD } from "clipper2-ts";
export type Pair = [number, number];
export type MultiPolygon = Pair[][][];

// Quantize every operation, including its intersections, on a page-relative
// grid. Carrying float intersection output into another sweep can otherwise
// manufacture self-enclosing rings from coincident edges (#296).
function operation(kind: ClipType, subject: MultiPolygon, clip: MultiPolygon): MultiPolygon {
  const paths = (polygons: MultiPolygon) => polygons.flatMap(polygon => polygon.map(ring => ring.map(([x, y]) => ({ x, y }))));
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(kind, paths(subject), paths(clip), tree, FillRule.EvenOdd, 8);
  const result: MultiPolygon = [];
  const nodes: PolyPathD[] = [tree];
  while (nodes.length) {
    const node = nodes.pop()!;
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i);
      const ring = (part: PolyPathD): Pair[] => part.poly!.map(({ x, y }) => [x, y]);
      result.push([ring(outer), ...Array.from({ length: outer.count }, (_, j) => ring(outer.child(j)))]);
      for (let j = 0; j < outer.count; j++) nodes.push(outer.child(j));
    }
  }
  return result;
}
// Bound total submitted vertices, not elapsed time: deterministic on every device.
export function createCoverageClipping(initialWork = 0) {
  let work = initialWork;
  const run = (kind: ClipType, subject: MultiPolygon, clip: MultiPolygon) => {
    for (const polygons of [subject, clip]) for (const polygon of polygons) for (const ring of polygon) work += ring.length;
    if (work > 500_000) throw new RangeError("ink_geometry_budget");
    return operation(kind, subject, clip);
  };
  return {
    get work() { return work; },
    difference: (subject: MultiPolygon, clip: MultiPolygon) => run(ClipType.Difference, subject, clip),
    intersection: (subject: MultiPolygon, clip: MultiPolygon) => run(ClipType.Intersection, subject, clip),
    union: (subject: MultiPolygon, clip: MultiPolygon) => run(ClipType.Union, subject, clip),
  };
}
