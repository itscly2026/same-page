import { readLogoutFence } from "../auth/logout-fence";
import { liveQuery } from "dexie";
import type { OfflineScoreRecord } from "../platform/local-database";
import { captureOfflineFileFence } from "./local-files";
import { imageManifestSchema, pageImagePath, scoreImagesPath, type ScoreDisplayMode, type ImageManifest } from "../../shared/score-images";
import { prepareImageManifest } from "../reader/image-document";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import type { ScoreSummary } from "../../shared/scores";
import { captureOfflineAnnotationSnapshot, ensureOfflineAppShell } from "../annotations/offline-snapshot";
import { syncAnnotations } from "../annotations/sync";
import { activateVerifiedOfflineScore, findActiveOfflineScore } from "../platform/local-database";
import { assertLocalWorkspaceActive, captureLocalWorkspaceSession, localWorkspaceRecordKey, type LocalWorkspace } from "../platform/local-workspace";

import { findVerifiedOfflineScore, sha256Hex, verifyOfflineScore } from "./offline-score-verification";

// Both entry points use the same verified replacement path. A failed attempt never
// activates the new PDF or removes the previous copy or local drafts. Confirmed
// publication revocations still scrub inaccessible notes, even on failure.
async function prepareOfflineScore(workspace: LocalWorkspace, score: ScoreSummary, mode: ScoreDisplayMode = "pdf", signal = new AbortController().signal, pdfData?: Uint8Array, fileFence?: string) {
  signal.throwIfAborted();
  fileFence ??= await captureOfflineFileFence(workspace);
  workspace = await captureLocalWorkspaceSession(workspace);
  if (workspace.choirId !== score.choirId || workspace.scoreId !== score.id) throw new Error("offline_score_scope_mismatch");
  const previous = await findActiveOfflineScore(workspace.ownerKey, workspace.choirId, workspace.scoreId);
  const base = `/api/choirs/${encodeURIComponent(score.choirId)}/scores/${encodeURIComponent(score.id)}`;
  let blob: Blob, hash: string, imageManifest: ImageManifest | undefined;
  if (mode === "images") {
    imageManifest = await prepareImageManifest(workspace, score.currentVersion.id, score.currentVersion.sha256, signal);
    if (imageManifest.pages.reduce((sum, page) => sum + page.assets[0].sizeBytes, 0) > 64 * 1024 * 1024) throw new Error("offline_image_memory_limit");
    const pieces: ArrayBuffer[] = [];
    const imageBase = scoreImagesPath(score.choirId, score.id, score.currentVersion.id);
    for (const page of imageManifest.pages) {
      signal.throwIfAborted();
      await assertLocalWorkspaceActive(workspace);
      const asset = page.assets[0];
      const response = await diagnosticFetch(pageImagePath(imageBase, imageManifest, page.pageNumber, asset.edge), { signal });
      if (!response.ok) throw new Error("offline_image_download_failed");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) throw new Error("offline_image_checksum_mismatch");
      await verifyImageDecode(new Blob([bytes], { type: "image/png" }), asset.width, asset.height);
      pieces.push(bytes);
    }
    blob = new Blob(pieces, { type: "application/octet-stream" });
    hash = await sha256Hex(await blob.arrayBuffer());
  } else {
    let data: ArrayBuffer;
    if (pdfData) {
      data = pdfData.slice().buffer;
    } else {
      const response = await diagnosticFetch(`${base}/versions/${encodeURIComponent(score.currentVersion.id)}/pdf`, { signal });
      if (!response.ok) throw new Error("offline_pdf_download_failed");
      data = await response.arrayBuffer();
    }
    if (data.byteLength !== score.currentVersion.sizeBytes || await sha256Hex(data) !== score.currentVersion.sha256) throw new Error("offline_pdf_checksum_mismatch");
    blob = new Blob([data], { type: "application/pdf" });
    hash = score.currentVersion.sha256;
  }
  signal.throwIfAborted();
  await ensureOfflineAppShell();
  signal.throwIfAborted();
  await assertLocalWorkspaceActive(workspace);
  // This call requires a layer request started after the bytes are prepared;
  // an earlier reader refresh cannot establish fresh access for activation.
  let annotationSnapshot;
  try {
    await syncAnnotations(workspace, { pull: true, push: false, signal });
    signal.throwIfAborted();
    annotationSnapshot = await captureOfflineAnnotationSnapshot(workspace);
  } catch (cause) { throw new OfflineAnnotationPreparationError("offline_annotations_unavailable", { cause }); }
  const record = {
    key: localWorkspaceRecordKey(workspace, `${score.currentVersion.id}:${mode}`), ...workspace,
    versionId: score.currentVersion.id, fileName: score.fileName,
    sha256: hash, pageCount: score.currentVersion.pageCount,
    blob, ...(imageManifest ? { imageManifest: imageManifestSchema.parse(imageManifest) } : {}), annotationSnapshot,
  };
  if (!(await verifyOfflineScore({ ...record, active: 1, verifiedAt: Date.now() }))) throw new Error("offline_annotation_snapshot_incomplete");
  signal.throwIfAborted();
  await activateVerifiedOfflineScore(record, { activeKey: previous?.key ?? null, fileFence, signal });
  const verified = await findVerifiedOfflineScore(workspace);
  if (!verified || verified.versionId !== score.currentVersion.id || (verified.imageManifest ? "images" : "pdf") !== mode) throw new Error("offline_copy_unavailable");
  return verified;
}

async function verifyImageDecode(blob: Blob, width: number, height: number) {
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("offline_image_decode_timeout")), 20_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error("offline_image_corrupt")); };
      image.src = url;
    });
    if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error("offline_image_dimensions_mismatch");
  } finally { image.src = ""; URL.revokeObjectURL(url); }
}


class OfflineAnnotationPreparationError extends Error {}

export type OfflinePreparationState =
  | { phase: "idle" | "cancelled" }
  | { phase: "preparing"; intent: "automatic" | "explicit" }
  | { phase: "failed"; reason: "identity" | "download" | "annotations" }
  | { phase: "ready"; record: OfflineScoreRecord };
type PreparationTask = {
  controller: AbortController;
  ownerKey: string;
  targetKey: string;
  automatic: Set<OfflinePreparation>;
  explicit: boolean;
  state: OfflinePreparationState;
  result: Promise<OfflinePreparationState>;
};
const preparations = new Map<string, PreparationTask>();
const identityGenerations = new Map<string, number>();
export function revokeOfflinePreparationIdentity(userId: string) {
  const ownerKey = `user:${userId}`;
  identityGenerations.set(ownerKey, (identityGenerations.get(ownerKey) ?? 0) + 1);
  for (const task of preparations.values()) if (task.ownerKey === ownerKey) task.controller.abort();
}
const pendingRequests = new Map<OfflinePreparation, "automatic" | "explicit">();
function cancelUnownedPreparations() {
  for (const task of preparations.values()) {
    const joining = [...pendingRequests.keys()].some(request => request.targetKey === task.targetKey);
    if (!joining && !task.explicit && !task.automatic.size) task.controller.abort();
  }
}
const observers = new Set<OfflinePreparation>();

// A consumer owns only its automatic intent. Explicit intent belongs to this
// tab until completion; unmounting its UI never releases the download.
export class OfflinePreparation {
  private state: OfflinePreparationState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private disposed = false;
  private attempted = false;
  private key = "";
  private task?: PreparationTask;
  readonly targetKey: string;
  private identityGeneration = 0;
  private context: Promise<{ workspace: LocalWorkspace; fence: string }>;

  constructor(private readonly workspace: LocalWorkspace, readonly score: ScoreSummary, readonly mode: ScoreDisplayMode, authenticatedUserId: string | null, fileFence?: Promise<string>) {
    this.targetKey = JSON.stringify([workspace.scopeKey, score.currentVersion.id, mode]);
    this.identityGeneration = identityGenerations.get(workspace.ownerKey) ?? 0;
    this.context = (async () => {
      if (workspace.ownerKey.startsWith("user:") && workspace.ownerKey !== `user:${authenticatedUserId ?? ""}`) throw new Error("offline_identity_unconfirmed");
      const session = await captureLocalWorkspaceSession(workspace);
      const fence = await (fileFence ?? captureOfflineFileFence(session));
      this.key = JSON.stringify([session.scopeKey, session.sessionEpoch, this.identityGeneration, fence, score.currentVersion.id, mode]);
      if (!this.disposed) {
        observers.add(this);
        this.observe();
      }
      return { workspace: session, fence };
    })();
    void this.context.catch(() => undefined);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: OfflinePreparationState) {
    if (this.disposed) return;
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  private observe() {
    const task = preparations.get(this.key);
    this.publish(task?.state ?? this.state);
  }
  prepare = async (intent: "automatic" | "explicit", pdfData?: () => Promise<Uint8Array>): Promise<OfflinePreparationState> => {
    if (this.disposed) return { phase: "cancelled" };
    if (intent === "automatic" && this.attempted) return this.state;
    this.attempted = true;
    // Capture at the click, before any pending context can yield to cleanup.
    const requestFence = intent === "explicit" ? captureOfflineFileFence(this.workspace) : undefined;
    void requestFence?.catch(() => undefined);
    pendingRequests.set(this, intent);
    this.publish({ phase: "preparing", intent });
    let context: Awaited<typeof this.context>;
    try {
      context = await this.context;
      await assertLocalWorkspaceActive(context.workspace);
      if (this.identityGeneration !== (identityGenerations.get(context.workspace.ownerKey) ?? 0)) throw new Error("offline_identity_changed");
      const logout = await readLogoutFence();
      if (logout && context.workspace.ownerKey === `user:${logout.userId}`) throw new Error("offline_identity_changed");
      if (requestFence) context = { ...context, fence: await requestFence };
      this.key = JSON.stringify([context.workspace.scopeKey, context.workspace.sessionEpoch, this.identityGeneration, context.fence, this.score.currentVersion.id, this.mode]);
    }
    catch { pendingRequests.delete(this); cancelUnownedPreparations(); const state: OfflinePreparationState = { phase: "failed", reason: "identity" }; this.publish(state); return state; }
    // Explicit requests survive disposal even while capturing the session/fence.
    if (this.disposed && intent === "automatic") { pendingRequests.delete(this); cancelUnownedPreparations(); return { phase: "cancelled" }; }
    let task = preparations.get(this.key);
    if (!task || task.controller.signal.aborted) {
      const controller = new AbortController();
      task = { controller, ownerKey: context.workspace.ownerKey, targetKey: this.targetKey, automatic: new Set(), explicit: false, state: { phase: "preparing", intent }, result: Promise.resolve({ phase: "idle" }) };
      preparations.set(this.key, task);
      const ownedTask = task;
      const key = this.key;
      const notify = () => { for (const observer of observers) if (observer.key === key) observer.observe(); };
      // Observe persisted fences for other-tab cleanup/identity changes too.
      const watcher = liveQuery(async () => {
        await assertLocalWorkspaceActive(context.workspace);
        const logout = await readLogoutFence();
        if (logout && context.workspace.ownerKey === `user:${logout.userId}`) return false;
        return await captureOfflineFileFence(context.workspace) === context.fence;
      }).subscribe({ next: valid => { if (!valid) controller.abort(); }, error: () => controller.abort() });
      task.result = (async (): Promise<OfflinePreparationState> => {
        try {
          const bytes = await pdfData?.().catch(() => undefined);
          controller.signal.throwIfAborted();
          const record = await prepareOfflineScore(context.workspace, this.score, this.mode, controller.signal, bytes, context.fence);
          return { phase: "ready", record };
        } catch (error) { return controller.signal.aborted ? { phase: "cancelled" } : { phase: "failed", reason: error instanceof OfflineAnnotationPreparationError ? "annotations" : "download" }; }
        finally { watcher.unsubscribe(); }
      })().then(state => {
        ownedTask.state = state;
        if (preparations.get(key) === ownedTask) { notify(); preparations.delete(key); }
        return state;
      });
      notify();
    }
    this.task = task;
    if (intent === "explicit") {
      task.explicit = true;
      task.state = { phase: "preparing", intent: "explicit" };
      for (const observer of observers) if (observer.key === this.key) observer.observe();
    }
    else task.automatic.add(this);
    this.publish(task.state);
    pendingRequests.delete(this);
    cancelUnownedPreparations();
    return task.result;
  };
  dispose() {
    this.disposed = true;
    observers.delete(this);
    this.listeners.clear();
    if (pendingRequests.get(this) === "automatic") pendingRequests.delete(this);
    this.task?.automatic.delete(this);
    cancelUnownedPreparations();
  }
}
