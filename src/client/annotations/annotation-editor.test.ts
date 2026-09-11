import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, captureLocalWorkspaceSession, createLocalWorkspace, experienceOwnerKey } from "../platform/local-workspace";
import * as annotationState from "./annotation-state";
import { OUTBOX_RECOVERY_REQUEST_EVENT } from "./outbox-recovery";
import { clearDiagnostics, exportDiagnostics } from "../diagnostics/diagnostics";
import { readScoreAnnotationState, type DraftInput } from "./annotation-state";
import { GUEST_NOTE_LAYER_ID } from "./guest-notes";
import { AnnotationEditor } from "./annotation-editor";

const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("editor"), "drive", "score");
const text = (value: string, id = "note"): DraftInput => ({ id, layerId: "personal", payload: {
  kind: "text", text: value, pageNumber: 1, x: 0.1, y: 0.2, fontScale: 0.024,
} });
let editor: AnnotationEditor;

beforeEach(async () => {
  await localDatabase.open();
  await localDatabase.delete();
  await localDatabase.open();
  await activateAuthenticatedLocalOwner("editor");
  editor = new AnnotationEditor(await captureLocalWorkspaceSession(workspace));
  editor.begin();
});
afterEach(() => { editor.cancel(); vi.restoreAllMocks(); });

async function savedText() {
  const { annotations } = await readScoreAnnotationState(workspace);
  return annotations.find(note => note.id === "note")?.payload;
}

it("serializes consecutive writes and history operations before allowing completion", async () => {
  const a = editor.persist(text("A"));
  const b = editor.persist(text("B"));
  const undo = editor.undo("personal");
  expect(editor.getSnapshot()).toBe("saving");
  expect(editor.discard("note")).toBe(false);
  expect(await Promise.all([a, b, undo])).toEqual([true, true, true]);
  expect(await savedText()).toMatchObject({ text: "A" });
  expect(await editor.redo("personal")).toBe(true);
  expect(await savedText()).toMatchObject({ text: "B" });
  expect(await editor.finish()).toBe("local-saved");
  expect(await editor.persist(text("outside edit"))).toBe(false);
  editor.begin();
  expect(await editor.undo("personal")).toBe(false);
});

it("retains failed redo and queued writes in order, advancing history only after retry succeeds", async () => {
  await editor.persist(text("A"));
  await editor.persist(text("B"));
  await editor.undo("personal");
  const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
  const redo = editor.redo("personal");
  const next = editor.persist(text("C"));
  expect(await redo).toBe(false);
  expect(await next).toBe(false);
  expect(editor.getSnapshot()).toBe("failed");
  expect(await savedText()).toMatchObject({ text: "A" });
  write.mockRestore();
  expect(await editor.retry()).toBe(true);
  expect(await savedText()).toMatchObject({ text: "C" });
  await editor.undo("personal");
  expect(await savedText()).toMatchObject({ text: "B" });
  await editor.undo("personal");
  expect(await savedText()).toMatchObject({ text: "A" });
});

it("retries one failed stroke as a single undoable change including its latest points", async () => {
  const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("storage unavailable"));
  const first = editor.persist(text("initial stroke"));
  const latest = editor.persist(text("final stroke"), true);
  expect(await first).toBe(false);
  expect(await latest).toBe(false);
  write.mockRestore();
  expect(await editor.retry()).toBe(true);
  expect(await savedText()).toMatchObject({ text: "final stroke" });
  expect(await editor.undo("personal")).toBe(true);
  expect(await savedText()).toBeUndefined();
  expect(await editor.undo("personal")).toBe(false);
});

it("cancels failed text without resurrecting it on retry or recording phantom history", async () => {
  vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("storage unavailable"));
  expect(await editor.persist(text("cancel me"))).toBe(false);
  expect(editor.discard("note")).toBe(true);
  expect(editor.discard("note")).toBe(false);
  expect(editor.getSnapshot()).toBe("idle");
  expect(await editor.retry()).toBe(true);
  expect(await savedText()).toBeUndefined();
  expect(await editor.undo("personal")).toBe(false);
  expect(await editor.finish()).toBe("local-saved");
});

it("ignores a retired session's late failure and never executes its queued intent", async () => {
  let reject!: (error: Error) => void;
  const write = vi.spyOn(localDatabase.annotations, "put").mockImplementationOnce(() => new Dexie.Promise((_resolve, fail) => { reject = fail; }));
  const old = editor.persist(text("old"));
  const queued = editor.persist(text("must not execute", "queued"));
  await waitFor(() => expect(write).toHaveBeenCalled());
  editor.cancel();
  expect(await old).toBe(false);
  expect(await queued).toBe(false);
  editor.begin();
  reject(new Error("late failure"));
  write.mockRestore();
  expect(await editor.persist(text("new"))).toBe(true);
  expect(editor.getSnapshot()).toBe("idle");
  expect((await readScoreAnnotationState(workspace)).annotations).toHaveLength(1);
  expect(await editor.undo("personal")).toBe(true);
  expect(await savedText()).toBeUndefined();
  expect(await editor.undo("personal")).toBe(false);
});

it("keeps another reader's history independent and fences a previous owner epoch", async () => {
  await editor.persist(text("A"));
  const other = new AnnotationEditor(await captureLocalWorkspaceSession(workspace));
  other.begin();
  await other.persist(text("other", "other-note"));
  await other.finish();
  expect(await editor.undo("personal")).toBe(true);
  await activateAuthenticatedLocalOwner("different-user");
  await activateAuthenticatedLocalOwner("editor");
  expect(await editor.persist(text("stale"))).toBe(false);
  expect(await editor.retry()).toBe(false);
  expect(await savedText()).toBeUndefined();
});

it("keeps the newest intent when editing again after several stroke writes failed", async () => {
  const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("storage unavailable"));
  const first = editor.persist(text("first"));
  const next = editor.persist(text("second"), true);
  await Promise.all([first, next]);
  write.mockRestore();
  expect(await editor.persist(text("latest"), true)).toBe(true);
  await waitFor(() => expect(editor.getSnapshot()).toBe("idle"));
  expect(await savedText()).toMatchObject({ text: "latest" });
  await editor.undo("personal");
  expect(await savedText()).toBeUndefined();
});

it("canceled checkpoints do not consume undo or resurrect on redo", async () => {
  await editor.persist(text("A"));
  await editor.persist(text("checkpoint", "stroke"));
  await editor.persist({ id: "stroke", layerId: "personal", payload: null, deleted: true }, true);
  expect(await editor.undo("personal")).toBe(true);
  expect(await savedText()).toBeUndefined();
  expect(await editor.redo("personal")).toBe(true);
  expect(await savedText()).toMatchObject({ text: "A" });
  expect(await editor.redo("personal")).toBe(false);
});

it("canceling a failed first checkpoint leaves no phantom undo entry", async () => {
  const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("full"));
  expect(await editor.persist(text("checkpoint", "stroke"))).toBe(false);
  write.mockRestore();
  await editor.persist({ id: "stroke", layerId: "personal", payload: null, deleted: true }, true);
  expect(await editor.undo("personal")).toBe(false);
});


it("shares completion and queues in-flight edits plus registered input before exiting without waiting for recovery", async () => {
  let release!: () => void;
  const input = new Promise<void>(resolve => { release = resolve; });
  const commit = vi.fn(async () => { await input; return editor.persist(text("composed text")); });
  editor.registerFinishCommit(commit);
  const recovery = vi.fn(() => new Promise<void>(() => {}));
  window.addEventListener(OUTBOX_RECOVERY_REQUEST_EVENT, recovery);
  try {
    const stroke = editor.persist(text("in-flight stroke", "stroke"));
    const first = editor.finish();
    expect(editor.finish()).toBe(first);
    await waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(await stroke).toBe(true);
    expect(editor.begin()).toBe(false);
    expect(recovery).not.toHaveBeenCalled();
    release();
    expect(await first).toBe("local-saved");
    expect(await readScoreAnnotationState(workspace)).toMatchObject({ pendingCount: 2 });
    expect(await savedText()).toMatchObject({ text: "composed text" });
    expect(recovery).toHaveBeenCalledOnce();
    expect(await editor.persist(text("closed"))).toBe(false);
  } finally { window.removeEventListener(OUTBOX_RECOVERY_REQUEST_EVENT, recovery); }
});

it("keeps editing and durable drafts after queue failure, then completes on retry", async () => {
  await editor.persist(text("keep me"));
  const queue = vi.spyOn(annotationState, "queueScoreDrafts").mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
  expect(await editor.finish()).toBe("failed");
  expect(await savedText()).toMatchObject({ text: "keep me" });
  expect(editor.begin()).toBe(false);
  expect(await editor.persist(text("latest"))).toBe(true);
  queue.mockRestore();
  expect(await editor.finish()).toBe("local-saved");
  expect(await readScoreAnnotationState(workspace)).toMatchObject({ pendingCount: 1 });
  expect(await savedText()).toMatchObject({ text: "latest" });
});

it("retains a failed input commit for completion retry", async () => {
  editor.registerFinishCommit(() => editor.persist(text("composing")));
  const write = vi.spyOn(localDatabase.annotations, "put").mockRejectedValue(new DOMException("full", "QuotaExceededError"));
  expect(await editor.finish()).toBe("failed");
  expect(editor.getSnapshot()).toBe("failed");
  expect(editor.begin()).toBe(false);
  write.mockRestore();
  expect(await editor.finish()).toBe("local-saved");
  expect(await savedText()).toMatchObject({ text: "composing" });
});

it("retires pending completion without letting its input callback finish a new edit session", async () => {
  let release!: (value: boolean) => void;
  const commit = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
  const unregister = editor.registerFinishCommit(commit);
  const finishing = editor.finish();
  await waitFor(() => expect(commit).toHaveBeenCalled());
  editor.cancel(); unregister();
  expect(editor.begin()).toBe(true);
  expect(await finishing).toBeNull();
  release(true);
  expect(await editor.persist(text("new session"))).toBe(true);
  expect(await editor.finish()).toBe("local-saved");
});

it("rejects completion after an owner identity round trip", async () => {
  await editor.persist(text("old owner"));
  await activateAuthenticatedLocalOwner("other");
  await activateAuthenticatedLocalOwner("editor");
  expect(await editor.finish()).toBe("failed");
  expect(await localDatabase.annotationOutbox.count()).toBe(0);
});

it("suppresses a late queue failure after cancellation and preserves the new session", async () => {
  let reject!: (error: unknown) => void;
  const queue = vi.spyOn(annotationState, "queueScoreDrafts").mockReturnValueOnce(new Promise<number>((_, fail) => { reject = fail; }));
  clearDiagnostics();
  const finishing = editor.finish();
  await waitFor(() => expect(queue).toHaveBeenCalled());
  editor.cancel(); editor.begin();
  expect(await finishing).toBeNull();
  reject(new DOMException("private storage error", "UnknownError"));
  queue.mockRestore();
  expect(await editor.persist(text("new"))).toBe(true);
  expect(JSON.parse(exportDiagnostics()).records).toEqual([]);
});

it("includes edits admitted while a previous draft batch is being queued", async () => {
  await editor.persist(text("first"));
  let release!: (count: number) => void;
  const queue = vi.spyOn(annotationState, "queueScoreDrafts").mockReturnValueOnce(new Promise<number>(resolve => { release = resolve; }));
  const finishing = editor.finish();
  await waitFor(() => expect(queue).toHaveBeenCalled());
  expect(await editor.persist(text("arrived during queue", "second"))).toBe(true);
  release(0);
  expect(await finishing).toBe("local-saved");
  expect(await readScoreAnnotationState(workspace)).toMatchObject({ pendingCount: 2 });
});

it("finishes local experience notes without creating an account outbox or requesting recovery", async () => {
  const experience = await captureLocalWorkspaceSession(createLocalWorkspace(experienceOwnerKey(workspace.ownerKey), "drive", "score"));
  const localEditor = new AnnotationEditor(experience);
  const recovery = vi.fn();
  window.addEventListener(OUTBOX_RECOVERY_REQUEST_EVENT, recovery);
  try {
    localEditor.begin();
    expect(await localEditor.persist({ ...text("experience"), layerId: GUEST_NOTE_LAYER_ID })).toBe(true);
    expect(await localEditor.finish()).toBe("local-saved");
    expect((await readScoreAnnotationState(experience)).annotations).toHaveLength(1);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(recovery).not.toHaveBeenCalled();
  } finally { localEditor.cancel(); window.removeEventListener(OUTBOX_RECOVERY_REQUEST_EVENT, recovery); }
});
