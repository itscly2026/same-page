import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, captureLocalWorkspaceSession, createLocalWorkspace } from "../platform/local-workspace";
import { readScoreAnnotationState, type DraftInput } from "./annotation-state";
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
  expect(editor.finish()).toBe(false);
  expect(await Promise.all([a, b, undo])).toEqual([true, true, true]);
  expect(await savedText()).toMatchObject({ text: "A" });
  expect(await editor.redo("personal")).toBe(true);
  expect(await savedText()).toMatchObject({ text: "B" });
  expect(editor.finish()).toBe(true);
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
  expect(editor.finish()).toBe(false);
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
  editor.discard("note");
  expect(editor.getSnapshot()).toBe("idle");
  expect(await editor.retry()).toBe(true);
  expect(await savedText()).toBeUndefined();
  expect(await editor.undo("personal")).toBe(false);
  expect(editor.finish()).toBe(true);
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
  other.finish();
  expect(await editor.undo("personal")).toBe(true);
  await activateAuthenticatedLocalOwner("different-user");
  await activateAuthenticatedLocalOwner("editor");
  expect(await editor.persist(text("stale"))).toBe(false);
  expect(await editor.retry()).toBe(false);
  expect(await savedText()).toBeUndefined();
});
