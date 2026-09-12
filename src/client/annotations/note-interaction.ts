import type { AnnotationPayload } from "../../shared/annotations";
import type { AnnotationEditor } from "./annotation-editor";

type Ink = Extract<AnnotationPayload, { kind: "ink" }>;
type Shape = Extract<AnnotationPayload, { kind: "shape" }>;
type Point = Ink["points"][number];
type Active = { pointerId: number; layerId: string } & (
  | { kind: "ink"; id: string; payload: Ink; checkpointAt: number }
  | { kind: "shape"; id: string; payload: Shape; start: Point }
  | { kind: "eraser"; ids: Set<string> }
);

export interface NoteInteractionSnapshot {
  draftId: string | null;
  stroke: Ink | null;
  shape: Shape | null;
  erased: ReadonlySet<string>;
}
const empty: NoteInteractionSnapshot = { draftId: null, stroke: null, shape: null, erased: new Set() };

// Owns only unreleased note intent. Released edits and durable-save recovery
// remain in AnnotationEditor, so interruption cannot undo an earlier gesture.
export class NoteInteraction {
  private active: Active | null = null;
  private frame: number | null = null;
  private snapshot = empty;
  private listeners = new Set<() => void>();
  constructor(private editor: Pick<AnnotationEditor, "persist"> | null) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get drawing() { return this.active !== null; }
  owns(pointerId: number) { return this.active?.pointerId === pointerId; }
  erasing(pointerId: number) { return this.active?.kind === "eraser" && this.owns(pointerId); }

  begin(pointerId: number, layerId: string, payload: Ink | Shape | "eraser", time: number) {
    if (this.active) return;
    if (payload === "eraser") this.active = { kind: "eraser", pointerId, layerId, ids: new Set() };
    else {
      const id = crypto.randomUUID();
      this.active = payload.kind === "ink"
        ? { kind: "ink", pointerId, layerId, id, payload, checkpointAt: time }
        : { kind: "shape", pointerId, layerId, id, payload, start: { x: payload.x, y: payload.y } };
      if (this.active.kind === "ink") void this.saveInk(this.active, false);
    }
    this.publish();
  }

  move(pointerId: number, point: Point, time: number) {
    const active = this.active;
    if (!active || !this.owns(pointerId)) return;
    if (active.kind === "shape") {
      const { start, payload } = active;
      active.payload = { ...payload, x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) };
      this.publish();
    } else if (active.kind === "ink") {
      // Keep the mutable input buffer separate from rendered/persisted snapshots.
      if (active.payload.points.length >= 5000) active.payload.points = active.payload.points.filter((_, index, points) => index % 2 === 0 || index === points.length - 1);
      active.payload.points.push(point);
      if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.publish(); });
      if (time - active.checkpointAt >= 120) { active.checkpointAt = time; void this.saveInk(active); }
    }
  }

  erase(pointerId: number, id: string) {
    const active = this.active;
    if (active?.kind !== "eraser" || !this.owns(pointerId) || active.ids.has(id)) return;
    active.ids.add(id);
    this.publish();
  }

  // Backgrounding preserves unfinished ink, but does not release its ownership.
  checkpoint = () => { if (this.active?.kind === "ink") void this.saveInk(this.active); };

  end = async (reason: "release" | "pointercancel" | "interrupt" | "finish", pointerId?: number, point?: Point): Promise<boolean> => {
    const active = this.active;
    if (!active || (pointerId !== undefined && !this.owns(pointerId))) return true;
    this.active = null;
    this.cancelFrame();
    const finishingEraser = active.kind === "eraser" && reason === "finish";
    if (!finishingEraser) this.publish();
    if (active.kind === "ink") {
      if (reason === "interrupt") return this.editor?.persist({ id: active.id, layerId: active.layerId, payload: null, deleted: true }, true) ?? true;
      if (reason === "release" && point && active.payload.points.length < 5000) {
        const last = active.payload.points.at(-1)!;
        if (point.x !== last.x || point.y !== last.y) active.payload.points.push(point);
      }
      return this.saveInk(active);
    }
    if (active.kind === "shape") {
      if (reason !== "release" || active.payload.width <= 0 || active.payload.height <= 0) return true;
      return this.editor?.persist({ id: active.id, layerId: active.layerId, payload: active.payload }) ?? true;
    }
    if (reason !== "release" && reason !== "finish") return true;
    const saved = await Promise.all([...active.ids].map(id => this.editor?.persist({ id, layerId: active.layerId, payload: null, deleted: true }) ?? true));
    // Keep the finish preview until its writes settle, as the editor waits for
    // reliable local completion. Never clear a newer gesture's preview.
    if (finishingEraser && !this.active) this.publish();
    return saved.every(Boolean);
  };

  dispose = () => { this.checkpoint(); this.cancelFrame(); };
  private cancelFrame() { if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; }
  private saveInk(active: Extract<Active, { kind: "ink" }>, coalesce = true) {
    return this.editor?.persist({ id: active.id, layerId: active.layerId, payload: { ...active.payload, points: [...active.payload.points] } }, coalesce) ?? Promise.resolve(true);
  }
  private publish() {
    const active = this.active;
    this.snapshot = active ? {
      draftId: active.kind === "ink" ? active.id : null,
      stroke: active.kind === "ink" ? { ...active.payload, points: [...active.payload.points] } : null,
      shape: active.kind === "shape" ? active.payload : null,
      erased: active.kind === "eraser" ? new Set(active.ids) : empty.erased,
    } : empty;
    for (const listener of this.listeners) listener();
  }
}
