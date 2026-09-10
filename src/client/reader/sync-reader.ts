import { readerSyncResponseSchema, type ReaderSyncResponse } from "../../shared/reader-sync";
import { applyPulledAnnotations, removeCachedPublications } from "../annotations/annotation-state";
import { applyLayerCapabilities, syncAnnotations, withScoreSyncLock } from "../annotations/sync";
import { DiagnosticResponseError, diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { untilAborted } from "../platform/abortable";
import { localDatabase } from "../platform/local-database";
import { assertLocalWorkspaceActive, captureLocalWorkspaceSession, type LocalWorkspace } from "../platform/local-workspace";
import { readingPreferenceVersion } from "./reading-preferences";

export class ReaderSyncError extends Error {
  constructor(readonly status: number) { super("reader_sync_failed"); }
}
type ReaderSyncState = ReaderSyncResponse | { state: "permission-denied" | "missing" | "network-unavailable" | "service-unavailable" };
type Listener = (result: ReaderSyncState) => void | Promise<void>;
const listeners = new Map<string, Set<(result: ReaderSyncState, workspace: LocalWorkspace) => Promise<void>>>();
const tasks = new Map<string, { promise: Promise<ReaderSyncResponse>; controller: AbortController; observers: number }>();
const keyFor = (workspace: LocalWorkspace) => JSON.stringify([workspace.scopeKey, workspace.sessionEpoch]);
export function subscribeReaderSync(workspace: LocalWorkspace, listener: Listener) {
  const identity = captureLocalWorkspaceSession(workspace);
  void identity.catch(() => undefined);
  const key = workspace.scopeKey, set = listeners.get(key) ?? new Set();
  let active = true;
  const notify = async (result: ReaderSyncState, source: LocalWorkspace) => {
    const captured = await identity;
    if (active && captured.sessionEpoch === source.sessionEpoch) await listener(result);
  };
  set.add(notify); listeners.set(key, set);
  return () => { active = false; set.delete(notify); if (!set.size) listeners.delete(key); };
}

// Only explicit read intents enter here. Outbox recovery invokes this after a
// successful batch; merely becoming online or visible never schedules a read.
export async function syncReader(workspace: LocalWorkspace, options: { signal?: AbortSignal; push?: boolean; fresh?: boolean } = {}) {
  workspace = await captureLocalWorkspaceSession(workspace);
  options.signal?.throwIfAborted();
  const key = keyFor(workspace);
  // A caller with newly queued writes must wait for an earlier read before
  // starting its own push/read cycle; simultaneous read-only intents coalesce.
  const pending = options.push !== false && await localDatabase.annotationOutbox.where("scopeKey").equals(workspace.scopeKey).count() > 0;
  const previous = tasks.get(key);
  if ((pending || options.fresh) && previous) await untilAborted(previous.promise.catch(() => undefined), options.signal ?? new AbortController().signal);
  let task = tasks.get(key);
  if (!task || task.controller.signal.aborted) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    task = { controller, observers: 0, promise: Promise.resolve().then(async () => {
      let pushError: unknown;
      try { if (pending) await syncAnnotations(workspace, { pull: false, signal }); } catch (error) { pushError = error; }
      signal.throwIfAborted();
      const notify = (result: ReaderSyncState) => Promise.all([...listeners.get(workspace.scopeKey) ?? []].map(listener => listener(result, workspace)));
      let result: ReaderSyncResponse | undefined;
      try { result = await withScoreSyncLock(workspace, locked => read(locked, signal), { signal }); }
      catch (error) {
        await assertLocalWorkspaceActive(workspace); signal.throwIfAborted();
        await notify({ state: error instanceof ReaderSyncError
          ? [401, 403].includes(error.status) ? "permission-denied" : error.status >= 500 ? "service-unavailable" : "missing"
          : error instanceof DiagnosticResponseError ? "service-unavailable" : "network-unavailable" });
        throw error;
      }
      if (!result) throw new Error("reader_sync_busy");
      await assertLocalWorkspaceActive(workspace);
      signal.throwIfAborted();
      await notify(result);
      if (pushError) throw pushError;
      return result;
    }) };
    tasks.set(key, task);
    const current = task;
    const clear = () => { if (tasks.get(key) === current) tasks.delete(key); };
    void task.promise.then(clear, clear);
  }
  const observed = task;
  observed.observers++;
  try { return await untilAborted(observed.promise, options.signal ?? new AbortController().signal); }
  finally { if (--observed.observers === 0) observed.controller.abort(); }
}

async function read(workspace: LocalWorkspace, signal: AbortSignal): Promise<ReaderSyncResponse> {
  const checkpoint = await localDatabase.annotationSyncCursors.get(workspace.scopeKey);
  let cursor = checkpoint?.cursor ?? 0, layerIds = checkpoint?.layerIds ?? [];
  const base = `/api/choirs/${encodeURIComponent(workspace.choirId)}/scores/${encodeURIComponent(workspace.scoreId)}/sync`;
  while (true) {
    const preferenceVersion = await readingPreferenceVersion(workspace);
    const query = new URLSearchParams({ cursor: String(cursor), layerIds: JSON.stringify(layerIds) });
    if (workspace.ownerKey.startsWith("experience:")) query.set("experience", "1");
    const response = await untilAborted(diagnosticFetch(`${base}?${query}`, { signal }), signal);
    await assertLocalWorkspaceActive(workspace); signal.throwIfAborted();
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) await removeCachedPublications(workspace);
      throw new ReaderSyncError(response.status);
    }
    const result = await parseDiagnosticResponse(response, readerSyncResponseSchema);
    await assertLocalWorkspaceActive(workspace); signal.throwIfAborted();
    if (result.state === "trashed") { await removeCachedPublications(workspace); return result; }
    await applyLayerCapabilities(workspace, result.layers, preferenceVersion, signal);
    const previousLayerIds = layerIds;
    layerIds = result.layers.layers.map(layer => layer.id).sort();
    await applyPulledAnnotations(workspace, result.annotations.cursor, result.annotations.objects, layerIds);
    if (!result.annotations.hasMore) return result;
    if (result.annotations.cursor === cursor && JSON.stringify(layerIds) === JSON.stringify(previousLayerIds)) throw new Error("reader_sync_cursor_stalled");
    cursor = result.annotations.cursor;
  }
}
