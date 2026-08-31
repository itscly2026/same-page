import {
  annotationRecordKey,
  localDatabase,
  type LocalAnnotationRecord,
} from "../platform/local-database";
import {
  saveAnnotationDraft,
  type DraftInput,
} from "./local-annotations";
import {
  type LocalWorkspace,
  withLocalWorkspaceTransaction,
} from "../platform/local-workspace";

interface HistoryEntry {
  before: LocalAnnotationRecord | null;
  after: DraftInput;
}

const undoByLayer = new Map<string, HistoryEntry[]>();
const redoByLayer = new Map<string, HistoryEntry[]>();

export function beginAnnotationEditSession() {
  undoByLayer.clear();
  redoByLayer.clear();
}

export function endAnnotationEditSession() {
  undoByLayer.clear();
  redoByLayer.clear();
}

export async function saveDraftWithHistory(
  workspace: LocalWorkspace,
  input: DraftInput,
) {
  const before =
    (await localDatabase.annotations.get(
      annotationRecordKey(workspace.scopeKey, input.id),
    )) ?? null;
  await saveAnnotationDraft(workspace, input);
  const stack = undoByLayer.get(input.layerId) ?? [];
  stack.push({ before, after: input });
  undoByLayer.set(input.layerId, stack);
  redoByLayer.set(input.layerId, []);
}

export async function updateLatestHistoryDraft(
  workspace: LocalWorkspace,
  input: DraftInput,
) {
  await saveAnnotationDraft(workspace, input);
  const stack = undoByLayer.get(input.layerId);
  if (stack?.length) stack[stack.length - 1].after = input;
}

export async function undoAnnotationEdit(
  workspace: LocalWorkspace,
  layerId: string,
) {
  const undo = undoByLayer.get(layerId) ?? [];
  const entry = undo.pop();
  if (!entry) return false;
  await restore(workspace, entry.before, entry.after.id);
  const redo = redoByLayer.get(layerId) ?? [];
  redo.push(entry);
  redoByLayer.set(layerId, redo);
  return true;
}

export async function redoAnnotationEdit(
  workspace: LocalWorkspace,
  layerId: string,
) {
  const redo = redoByLayer.get(layerId) ?? [];
  const entry = redo.pop();
  if (!entry) return false;
  await saveAnnotationDraft(workspace, entry.after);
  const undo = undoByLayer.get(layerId) ?? [];
  undo.push(entry);
  undoByLayer.set(layerId, undo);
  return true;
}

async function restore(
  workspace: LocalWorkspace,
  record: LocalAnnotationRecord | null,
  annotationId: string,
) {
  await withLocalWorkspaceTransaction(
    workspace,
    "rw",
    [localDatabase.annotations],
    async () => {
      const key = annotationRecordKey(workspace.scopeKey, annotationId);
      if (!record) {
        await localDatabase.annotations.delete(key);
      } else {
        await localDatabase.annotations.put(record);
      }
    },
  );
}
