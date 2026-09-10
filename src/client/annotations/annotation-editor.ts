import { annotationRecordKey, localDatabase } from "../platform/local-database";
import { captureLocalWorkspaceSession, withLocalWorkspaceTransaction, type LocalWorkspace } from "../platform/local-workspace";
import { saveAnnotationDraft, type DraftInput } from "./annotation-state";

export type PersistenceState = "idle" | "saving" | "failed";
type HistoryEntry = { before: DraftInput; after: DraftInput };
type Edit = { kind: "write"; input: DraftInput; replaceHistory: boolean }
  | { kind: "undo" | "redo"; layerId: string };
type PendingEdit = { edit: Edit; complete: (saved: boolean) => void };

// One mounted reader owns one editor. All local edits, including history, cross
// this queue; durable draft/OCC semantics remain in annotation-state.
export class AnnotationEditor {
  private readonly workspace: Promise<LocalWorkspace>;
  private readonly listeners = new Set<() => void>();
  private readonly undoByLayer = new Map<string, HistoryEntry[]>();
  private readonly redoByLayer = new Map<string, HistoryEntry[]>();
  private pending: PendingEdit[] = [];
  private generation = 0;
  private active = false;
  private running = false;
  private state: PersistenceState = "idle";

  constructor(workspace: LocalWorkspace) {
    this.workspace = captureLocalWorkspaceSession(workspace);
    // A reader may never enter editing after its identity has expired.
    void this.workspace.catch(() => undefined);
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  begin() {
    if (this.active || this.state !== "idle") return false;
    this.active = true;
    return true;
  }

  private readonly finishCommits = new Set<() => Promise<boolean>>();
  registerFinishCommit(commit: () => Promise<boolean>) {
    this.finishCommits.add(commit);
    return () => { this.finishCommits.delete(commit); };
  }
  async prepareFinish() {
    if (this.state === "saving") await new Promise<void>(resolve => {
      const unsubscribe = this.subscribe(() => { if (this.state !== "saving") { unsubscribe(); resolve(); } });
    });
    for (const commit of [...this.finishCommits]) {
      if (!await commit()) return false;
    }
    if (this.state === "failed" && !await this.retry()) return false;
    return this.active && this.state === "idle";
  }

  finish() {
    if (!this.active || this.state !== "idle") return false;
    this.cancel();
    return true;
  }

  // Unmount/identity change retires queued intent. Already admitted transactions
  // retain their workspace fence, but their completion cannot alter this session.
  cancel() {
    this.generation++;
    this.active = false;
    this.running = false;
    for (const task of this.pending) task.complete(false);
    this.pending = [];
    this.undoByLayer.clear();
    this.redoByLayer.clear();
    this.publish("idle");
  }

  persist(input: DraftInput, replaceHistory = false) {
    return this.enqueue({ kind: "write", input: structuredClone(input), replaceHistory });
  }
  undo(layerId: string) { return this.enqueue({ kind: "undo", layerId }); }
  redo(layerId: string) { return this.enqueue({ kind: "redo", layerId }); }

  discard(id: string) {
    if (this.running) return;
    this.pending = this.pending.filter(task => {
      if (task.edit.kind !== "write" || task.edit.input.id !== id) return true;
      task.complete(false);
      return false;
    });
    this.publish(this.pending.length ? "failed" : "idle");
  }

  retry() {
    if (!this.active || this.running) return Promise.resolve(false);
    const completion = Promise.all(this.pending.map(task => new Promise<boolean>(resolve => { task.complete = resolve; })));
    void this.drain();
    return completion.then(results => results.every(Boolean));
  }

  private enqueue(edit: Edit) {
    if (!this.active) return Promise.resolve(false);
    const completion = new Promise<boolean>(resolve => {
      // Editing a failed text again replaces that unwritten intent, without
      // erasing the history mode needed by a partially persisted stroke.
      const previous = !this.running ? this.pending.at(-1) : undefined;
      if (previous?.edit.kind === "write" && edit.kind === "write" && previous.edit.input.id === edit.input.id) {
        previous.complete(false);
        previous.edit = { ...edit, replaceHistory: previous.edit.replaceHistory && edit.replaceHistory };
        previous.complete = resolve;
      } else this.pending.push({ edit, complete: resolve });
    });
    void this.drain();
    return completion;
  }

  private async drain() {
    if (this.running || !this.active || !this.pending.length) return;
    this.running = true;
    const generation = this.generation;
    this.publish("saving");
    while (this.pending.length && generation === this.generation) {
      const task = this.pending[0];
      try {
        const changed = await this.apply(task.edit, generation);
        if (generation !== this.generation) return;
        this.pending.shift();
        task.complete(changed);
      } catch {
        if (generation !== this.generation) return;
        this.running = false;
        this.publish("failed");
        for (const pending of this.pending) pending.complete(false);
        return;
      }
    }
    if (generation === this.generation) {
      this.running = false;
      this.publish("idle");
    }
  }

  private async apply(edit: Edit, generation: number) {
    const workspace = await this.workspace;
    if (generation !== this.generation) return false;
    if (edit.kind === "write") {
      const input = edit.input;
      const before = await withLocalWorkspaceTransaction(workspace, "rw",
        [localDatabase.annotations, localDatabase.annotationOutbox, localDatabase.annotationConflicts], async () => {
          const previous = await localDatabase.annotations.get(annotationRecordKey(workspace.scopeKey, input.id));
          await saveAnnotationDraft(workspace, input);
          return { id: input.id, layerId: input.layerId, payload: previous?.payload ?? null, deleted: previous?.deleted ?? true };
        });
      if (generation !== this.generation) return false;
      const stack = this.undoByLayer.get(input.layerId) ?? [];
      const latest = stack.at(-1);
      if (edit.replaceHistory && latest?.after.id === input.id) {
        // A canceled new stroke returns to absence, so it is no longer an edit.
        if (latest.before.deleted && input.deleted) stack.pop();
        else latest.after = input;
      } else if (!(before.deleted && input.deleted)) stack.push({ before, after: input });
      this.undoByLayer.set(input.layerId, stack);
      this.redoByLayer.delete(input.layerId);
      return true;
    }
    const source = edit.kind === "undo" ? this.undoByLayer : this.redoByLayer;
    const destination = edit.kind === "undo" ? this.redoByLayer : this.undoByLayer;
    const stack = source.get(edit.layerId) ?? [];
    const entry = stack.at(-1);
    if (!entry) return false;
    await saveAnnotationDraft(workspace, edit.kind === "undo" ? entry.before : entry.after);
    if (generation !== this.generation) return false;
    stack.pop();
    const target = destination.get(edit.layerId) ?? [];
    target.push(entry);
    destination.set(edit.layerId, target);
    return true;
  }

  private publish(state: PersistenceState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
