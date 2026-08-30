import {
  annotationRecordKey,
  localDatabase,
  type LocalAnnotationRecord,
} from "../platform/local-database";
import {
  saveAnnotationDraft,
  type DraftInput,
} from "./local-annotations";

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
  choirId: string,
  scoreId: string,
  input: DraftInput,
) {
  const scopeKey = `${choirId}:${scoreId}`;
  const before =
    (await localDatabase.annotations.get(annotationRecordKey(scopeKey, input.id))) ?? null;
  await saveAnnotationDraft(choirId, scoreId, input);
  const stack = undoByLayer.get(input.layerId) ?? [];
  stack.push({ before, after: input });
  undoByLayer.set(input.layerId, stack);
  redoByLayer.set(input.layerId, []);
}

export async function updateLatestHistoryDraft(
  choirId: string,
  scoreId: string,
  input: DraftInput,
) {
  await saveAnnotationDraft(choirId, scoreId, input);
  const stack = undoByLayer.get(input.layerId);
  if (stack?.length) stack[stack.length - 1].after = input;
}

export async function undoAnnotationEdit(
  choirId: string,
  scoreId: string,
  layerId: string,
) {
  const undo = undoByLayer.get(layerId) ?? [];
  const entry = undo.pop();
  if (!entry) return false;
  await restore(choirId, scoreId, entry.before, entry.after.id);
  const redo = redoByLayer.get(layerId) ?? [];
  redo.push(entry);
  redoByLayer.set(layerId, redo);
  return true;
}

export async function redoAnnotationEdit(
  choirId: string,
  scoreId: string,
  layerId: string,
) {
  const redo = redoByLayer.get(layerId) ?? [];
  const entry = redo.pop();
  if (!entry) return false;
  await saveAnnotationDraft(choirId, scoreId, entry.after);
  const undo = undoByLayer.get(layerId) ?? [];
  undo.push(entry);
  undoByLayer.set(layerId, undo);
  return true;
}

async function restore(
  choirId: string,
  scoreId: string,
  record: LocalAnnotationRecord | null,
  annotationId: string,
) {
  const key = annotationRecordKey(`${choirId}:${scoreId}`, annotationId);
  if (!record) {
    await localDatabase.annotations.delete(key);
  } else {
    await localDatabase.annotations.put(record);
  }
}
