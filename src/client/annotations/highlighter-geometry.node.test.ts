import { describe, expect, it } from "vitest";
import { polygonContains } from "d3-polygon";
import { highlighterPasses, highlighterPose } from "./highlighter-geometry";
import type { AnnotationPayload } from "../../shared/annotations";
type Ink = Extract<AnnotationPayload, {kind:"ink"}>;
const base: Ink = {kind:"ink",brush:"highlighter",nib:"chisel",pressureMode:"uniform",strokeWidth:.04,opacity:.3,pageNumber:1,points:[]};
const depth = (ink:Ink,x:number,y:number) => highlighterPasses(ink,1).filter(pass => pass.some(polygon => polygonContains(polygon[0]!,[x,y]) && !polygon.slice(1).some(hole => polygonContains(hole,[x,y])))).length;
describe("highlighter deposition", () => {
  it.each(["round","chisel"] as const)("keeps a retraced %s stroke even without seams or sample-rate darkening", nib => {
    const sparse = {...base,nib,points:[{x:.1,y:.5},{x:.9,y:.5}]};
    const dense = {...base,nib,points:Array.from({length:101},(_,i)=>({x:.1+i*.008,y:.5}))};
    for (const x of [.3,.4,.5,.6,.7]) {
      expect(depth(sparse,x,.503)).toBe(1); expect(depth(dense,x,.503)).toBe(1);
      expect(depth({...dense,points:[...dense.points,{x:.1,y:.5}]},x,.503)).toBe(1);
    }
    const paused = {...dense,points:[...dense.points,...Array.from({length:20},()=>({x:.9,y:.5}))]};
    expect(highlighterPasses(paused,1)).toEqual(highlighterPasses(dense,1));
  });
  it("retains crossings and gives the same geometry for live prefixes and restored points", () => {
    const points=[{x:.2,y:.2},{x:.8,y:.8},{x:.2,y:.8},{x:.8,y:.2}];
    for(let i=1;i<=points.length;i++) highlighterPasses({...base,points:points.slice(0,i)},1);
    expect(depth({...base,points},.5,.5)).toBe(1);
    expect(highlighterPasses({...base,points},1)).toEqual(highlighterPasses({...base,points:structuredClone(points)},1));
  });
  it("uses barrel roll for the chisel footprint with a stable fallback", () => {
    const upright=highlighterPose(base,{x:.5,y:.5},1);
    const tilted=highlighterPose(base,{x:.5,y:.5,tiltX:60,tiltY:0},1);
    expect(tilted.length).toBe(upright.length);
    expect(tilted.thickness).toBe(upright.thickness);
    expect(tilted.angle).toBe(upright.angle);
    expect(highlighterPose(base,{x:.5,y:.5,tiltX:60,twist:90},1).angle-tilted.angle).toBeCloseTo(Math.PI/2);
    expect(highlighterPose({...base,nib:"round"},{x:.5,y:.5,tiltX:60,twist:90},1)).toEqual(highlighterPose({...base,nib:"round"},{x:.5,y:.5},1));
  });
});
