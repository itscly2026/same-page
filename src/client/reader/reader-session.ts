import { DiagnosticResponseError, diagnosticFetch, parseDiagnosticResponse, pdfFailureCategory, pdfFailureReason, pdfEngineVersion, recordFailure } from "../diagnostics/diagnostics";
import { annotationLayerListResponseSchema } from "../../shared/annotations";
import { readerScoreBootstrapSchema, type ScoreSummary } from "../../shared/scores";
import { cacheAnnotationLayers, readAnnotationLayers, restoreOfflineAnnotationSnapshot } from "../annotations/annotation-state";
import { syncAnnotations } from "../annotations/sync";
import { type OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { findVerifiedOfflineScore, hasCompleteOfflineLayers } from "../offline/offline-score-verification";
import { markLoadingJourneyMilestone } from "../performance/loading-performance";
import { acquireReaderDocument, confirmReaderDocumentVersion, invalidateReaderDocument, ReaderDocumentVersionMismatchError, type ReaderDocumentLease } from "./reader-document-cache";
import { peekReaderScore, rememberReaderScore, forgetReaderScore } from "./reader-score-cache";
import { ImageDocument, prepareImageManifest, type ScoreDocument } from "./image-document";
import { readDisplayPreference, writeDisplayPreference } from "./display-preferences";
import { scoreImagesPath, type ScoreDisplayMode } from "../../shared/score-images";

type CloudLookup = { state: "active"; score: ScoreSummary } | { state: "trashed" | "permission-denied" | "missing" | "network-unavailable" | "service-unavailable" };
type Source = { kind: "cloud" | "offline"; versionId?: string };
export interface ReaderSessionSnapshot {
  score: ScoreSummary | null;
  document: ScoreDocument | null;
  mode: ScoreDisplayMode;
  modeMessage: string | null;
  offline: OfflineScoreRecord | null;
  cloudState: "checking" | "active" | "trashed" | "unavailable";
  capability: "preparing" | "ready" | "failed" | "read-only" | "trashed";
  status: "loading" | "ready" | "error";
  error: string | null;
  downloading: boolean;
  downloadMessage: string | null;
}

// One lifetime owns source arbitration, capability preparation and document leases.
// Rendering and annotation editing remain independent consumers of this session.
export class ReaderSession {
  private state: ReaderSessionSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();
  private displayAbort = new AbortController();
  private started = false;
  private source: Source | null = null;
  private lease: ReaderDocumentLease | null = null;
  private generation = 0;
  private lookupSequence = 0;
  private appliedLookup = 0;
  private confirmedVersion: string | null;
  private localSettled = false;
  private cloudSettled = false;
  private pdfFailed = false;
  private automaticRecoveryUsed = false;
  private cloudInvalidated = false;
  private lookup: CloudLookup | null = null;
  private layerTask: Promise<void> | null = null;
  private refreshTask: Promise<void> | null = null;
  private readonly identity: string;

  constructor(readonly workspace: LocalWorkspace, private authenticatedUserId: string | null) {
    this.identity = authenticatedUserId ?? "guest";
    const score = peekReaderScore(this.identity, workspace.choirId, workspace.scoreId);
    this.confirmedVersion = score?.currentVersion.id ?? null;
    this.state = { mode: readDisplayPreference(workspace), modeMessage: null, score, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ReaderSessionSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private async current() { return !this.disposed && await assertLocalWorkspaceActive(this.workspace).then(() => true, () => false) && !this.disposed; }
  open() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.armDeadline();
    this.publish({});
    queueMicrotask(() => { if (!this.source) this.openSource({ kind: "cloud", versionId: this.confirmedVersion ?? undefined }); });
    void findVerifiedOfflineScore(this.workspace).catch(() => null).then(async (offline) => {
      if (!await this.current()) return;
      this.publish({ offline });
      if (offline) {
        if (this.localMatches() && (!this.state.document || this.state.cloudState !== "active")) await this.openOffline(offline);
        await restoreOfflineAnnotationSnapshot(this.workspace, offline).catch(() => undefined);
        if (!await this.current()) return;
        if (this.state.capability !== "trashed" && this.state.cloudState !== "active") {
          this.publish({ capability: offline.annotationSnapshot.layers.some((layer) => layer.canEdit) ? "ready" : "read-only" });
        }
        if (this.localMatches() && (!this.state.document || this.state.cloudState === "unavailable" || this.getSnapshot().cloudState === "trashed")) {
          await this.openOffline(offline);
        }
      }
      this.localSettled = true;
      this.resolveFailure();
    });
    void this.confirmCloud();
  }
  private armDeadline() {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.state.status === "loading") {
        this.publish({ status: "error", error: "加载用时较长，可以重试或返回云盘。这不代表设备不兼容。" });
        invalidateReaderDocument({ ...this.workspace });
        this.dispose();
      }
    }, this.state.mode === "images" ? 180_000 : 45_000);
  }
  refresh = () => {
    if (this.disposed || !navigator.onLine || globalThis.document.visibilityState === "hidden") return Promise.resolve();
    this.refreshTask ??= this.confirmCloud().finally(() => { this.refreshTask = null; });
    return this.refreshTask;
  };
  private localMatches() { return !!this.state.offline && (!this.confirmedVersion ? this.cloudSettled : this.confirmedVersion === this.state.offline.versionId) && (this.state.offline.imageManifest ? "images" : "pdf") === this.state.mode; }
  private async confirmCloud() {
    const sequence = ++this.lookupSequence;
    const lookup = await lookupScore(this.workspace, this.abort.signal);
    if (!await this.current() || sequence < this.appliedLookup) return;
    const unavailable = lookup.state === "network-unavailable" || lookup.state === "service-unavailable";
    if (!unavailable) this.appliedLookup = sequence;
    this.cloudSettled = true;
    this.lookup = lookup;
    if (lookup.state === "active") {
      this.confirmedVersion = lookup.score.currentVersion.id;
      rememberReaderScore(this.identity, lookup.score);
      this.publish({ score: lookup.score, cloudState: "active", ...(this.pdfFailed ? {} : { error: null }) });
      const confirmation = confirmReaderDocumentVersion({ ...this.workspace, sourceKind: "cloud", versionId: this.confirmedVersion });
      if ((this.source?.kind === "offline" || this.state.mode === "images") && this.source?.versionId === this.confirmedVersion) {
        // A matching offline document already owns the display lease.
      } else if (this.localMatches() && !this.state.document) {
        await this.openOffline(this.state.offline!);
      } else if ((confirmation !== "match" || this.source?.kind !== "cloud") && !(this.pdfFailed && !this.cloudInvalidated && this.source?.kind === "cloud" && (!this.source.versionId || this.source.versionId === this.confirmedVersion))) {
        this.openSource({ kind: "cloud", versionId: this.confirmedVersion });
      }
      void this.retryLayers();
    } else {
      if (!unavailable) {
        this.cloudInvalidated = true;
        this.confirmedVersion = null;
        forgetReaderScore(this.identity, this.workspace.choirId, this.workspace.scoreId);
        invalidateReaderDocument({ ...this.workspace, sourceKind: "cloud" });
      }
      this.publish({ cloudState: lookup.state === "trashed" ? "trashed" : "unavailable", ...(lookup.state === "trashed" ? { capability: "trashed" as const } : {}) });
      if (this.localMatches()) void this.openOffline(this.state.offline!);
      if (lookup.state !== "trashed") void this.retryLayers();
    }
    this.resolveFailure();
  }
  private async openOffline(offline: OfflineScoreRecord) {
    if (this.source?.kind === "offline" && this.source.versionId === offline.versionId) return;
    const generation = this.generation;
    const data = offline.imageManifest ? undefined : await offline.blob.arrayBuffer();
    if (!await this.current() || generation !== this.generation || !this.localMatches()) return;
    if (this.state.cloudState !== "active") this.publish({ score: scoreFromOffline(offline) });
    this.openSource({ kind: "offline", versionId: offline.versionId }, data);
  }
  private openSource(source: Source, data?: ArrayBuffer) {
    if (this.disposed) return;
    if (this.state.mode === "images" && source.kind === "cloud" && !this.state.score) return;
    this.armDeadline();
    this.displayAbort.abort();
    this.displayAbort = new AbortController();
    const generation = ++this.generation;
    this.lease?.release();
    this.source = source;
    if (source.kind === "cloud") this.cloudInvalidated = false;
    this.pdfFailed = false;
    this.publish({ document: null, status: "loading", error: null });
    if (this.state.mode === "images") {
      const score = this.state.score!;
      const local = source.kind === "offline" ? this.state.offline : null;
      const signal = this.displayAbort.signal;
      const manifest = local?.imageManifest
        ? Promise.resolve(local.imageManifest)
        : prepareImageManifest(this.workspace, source.versionId!, score.currentVersion.sha256, signal);
      void manifest.then(async manifest => {
        if (!await this.current() || generation !== this.generation) return;
        this.publish({ document: new ImageDocument(manifest, scoreImagesPath(this.workspace.choirId, this.workspace.scoreId, manifest.versionId), local?.blob), status: "ready" });
      }).catch(error => {
        if (this.disposed || generation !== this.generation) return;
        recordFailure({ operation: "pdf", category: pdfFailureCategory(error), stage: "prepare" });
        this.publish({ status: "error", error: "图片兼容模式准备失败，可以重试或选择 PDF 阅读。本机草稿仍然保留。" });
      });
      return;
    }
    markLoadingJourneyMilestone("open-score", "pdf-task-start");
    const lease = acquireReaderDocument({ ...this.workspace, source: data ?? cloudPdfSource(this.workspace, source.versionId), sourceKind: source.kind, versionId: source.versionId });
    this.lease = lease;
    void lease.promise.then(async (document) => {
      if (!await this.current() || generation !== this.generation) return;
      this.publish({ document, status: "ready" });
      this.resolveFailure();
    }).catch((error) => {
      if (this.disposed || generation !== this.generation) return;
      recordFailure({ operation: "pdf", category: pdfFailureCategory(error), stage: "decode", pdfReason: pdfFailureReason(error), engineVersion: pdfEngineVersion });
      if (error instanceof ReaderDocumentVersionMismatchError && source.kind === "cloud" && source.versionId !== error.expectedVersionId) {
        this.openSource({ kind: "cloud", versionId: error.expectedVersionId });
        return;
      }
      if (error instanceof Error && error.name === "PdfEngineUnavailableError" && this.recoverDisplay(error)) return;
      this.pdfFailed = true;
      this.resolveFailure();
    });
  }
  private resolveFailure() {
    if (!this.localSettled || !this.cloudSettled || this.disposed) return;
    if (this.lookup && this.lookup.state !== "active" && !this.localMatches() && !this.confirmedVersion) {
      this.publish({ status: "error", error: failureMessage(this.lookup.state) });
    } else if (this.pdfFailed) {
      this.publish({ status: "error", error: this.source?.kind === "offline" ? "本机离线副本无法解析，现有批注仍然保留。" : "PDF 无法解析或文件暂时不可用。" });
    }
  }
  retryLayers = () => {
    if (this.disposed || this.getSnapshot().cloudState === "trashed") return Promise.resolve();
    this.layerTask ??= this.prepareLayers().finally(() => { this.layerTask = null; });
    return this.layerTask;
  };
  private async prepareLayers() {
    if (this.state.capability !== "ready") this.publish({ capability: "preparing" });
    try {
      const response = await diagnosticFetch(`${scorePath(this.workspace)}/layers`, { signal: this.abort.signal });
      if (!response.ok) throw new Error("layers_unavailable");
      const { layers } = await parseDiagnosticResponse(response, annotationLayerListResponseSchema);
      if (!await this.current() || this.getSnapshot().cloudState === "trashed") return;
      if (this.workspace.ownerKey.startsWith("user:") && this.workspace.ownerKey !== `user:${this.authenticatedUserId ?? ""}`) throw new Error("layer_identity_mismatch");
      if (!hasCompleteOfflineLayers(layers, this.workspace.ownerKey)) throw new Error("layer_snapshot_incomplete");
      const previous = await readAnnotationLayers(this.workspace);
      if (!await this.current()) return;
      await cacheAnnotationLayers(this.workspace, this.authenticatedUserId ? layers : layers.map((layer) => ({ ...layer, subscribed: previous.find((entry) => entry.id === layer.id)?.subscribed ?? layer.subscribed })));
      if (!await this.current() || this.getSnapshot().cloudState === "trashed") return;
      this.publish({ capability: layers.some((layer) => layer.canEdit) ? "ready" : "read-only" });
      await syncAnnotations(this.workspace, { pull: true }).catch(() => undefined);
    } catch {
      if (!await this.current() || this.getSnapshot().cloudState === "trashed") return;
      this.publish({ capability: this.state.offline ? (this.state.offline.annotationSnapshot.layers.some((layer) => layer.canEdit) ? "ready" : "read-only") : "failed" });
    }
  }
  download = async () => {
    if (this.disposed || !this.state.score || this.state.downloading) return;
    this.publish({ downloading: true, downloadMessage: null });
    try {
      const { prepareOfflineScore } = await import("../offline/offline-score");
      const offline = await prepareOfflineScore(this.workspace, this.state.score, this.state.mode, this.abort.signal);
      if (!await this.current()) return;
      this.publish({ offline, downloadMessage: "离线副本已完整校验，可以离线打开。" });
      if (this.source?.kind === "offline" && this.localMatches()) await this.openOffline(offline);
    } catch {
      this.publish({ downloadMessage: "离线下载未完成，现有离线版本没有切换。请重试。" });
    } finally { this.publish({ downloading: false }); }
  };
  recoverDisplay = (error: unknown) => {
    if (this.disposed || this.state.mode !== "pdf" || this.automaticRecoveryUsed || !navigator.onLine || pdfFailureCategory(error) !== "internal" || (error instanceof Error && error.name === "TimeoutError")) return false;
    this.automaticRecoveryUsed = true;
    if (!this.changeMode("images", false)) return false;
    this.publish({ modeMessage: "PDF 显示失败，已尝试图片兼容模式。你仍可切回 PDF 阅读。" });
    return true;
  };
  selectMode = (mode: ScoreDisplayMode) => { this.changeMode(mode, true); };
  private changeMode(mode: ScoreDisplayMode, persist: boolean) {
    if (this.disposed || mode === this.state.mode) return false;
    if ((!navigator.onLine || this.lookup?.state === "network-unavailable") && (!this.state.offline || (this.state.offline.imageManifest ? "images" : "pdf") !== mode)) {
      this.publish({ modeMessage: `本机没有${mode === "images" ? "图片" : "PDF"}离线副本，请联网后下载。当前副本仍可使用。` });
      return false;
    }
    if (persist) writeDisplayPreference(this.workspace, mode, "score");
    this.displayAbort.abort();
    this.generation++;
    this.lease?.release();
    this.lease = null;
    this.source = null;
    this.pdfFailed = false;
    this.publish({ mode, modeMessage: null, document: null, status: "loading", error: null });
    this.armDeadline();
    if (this.localMatches()) void this.openOffline(this.state.offline!);
    else if (this.confirmedVersion) this.openSource({ kind: "cloud", versionId: this.confirmedVersion });
    else void this.confirmCloud();
    return true;
  }
  setDefaultMode = (mode: ScoreDisplayMode | null) => writeDisplayPreference(this.workspace, mode, "default");
  resetMode = () => {
    writeDisplayPreference(this.workspace, null, "score");
    this.changeMode(readDisplayPreference(this.workspace), false);
  };
  cancel = () => {
    this.publish({ status: "error", error: "加载已取消，本机草稿仍然保留。" });
    invalidateReaderDocument({ ...this.workspace });
    this.dispose();
  };
  dispose() {
    this.disposed = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.abort.abort();
    this.displayAbort.abort();
    this.generation++;
    this.lease?.release();
    this.lease = null;
    this.listeners.clear();
  }
}
function scorePath(workspace: LocalWorkspace) { return `/api/choirs/${encodeURIComponent(workspace.choirId)}/scores/${encodeURIComponent(workspace.scoreId)}`; }
function cloudPdfSource(workspace: LocalWorkspace, versionId?: string) { return versionId ? `${scorePath(workspace)}/versions/${encodeURIComponent(versionId)}/pdf` : `${scorePath(workspace)}/pdf`; }
async function lookupScore(workspace: LocalWorkspace, signal: AbortSignal): Promise<CloudLookup> {
  try {
    const response = await diagnosticFetch(`${scorePath(workspace)}/bootstrap`, { signal });
    if (response.status === 401 || response.status === 403) return { state: "permission-denied" };
    if (!response.ok) return { state: response.status >= 500 ? "service-unavailable" : "missing" };
    const body = await parseDiagnosticResponse(response, readerScoreBootstrapSchema);
    return body.state === "active" ? { state: "active", score: body.score } : { state: "trashed" };
  } catch (error) { return { state: error instanceof DiagnosticResponseError ? "service-unavailable" : "network-unavailable" }; }
}
function failureMessage(state: Exclude<CloudLookup["state"], "active">) {
  return { trashed: "这份乐谱已移入回收站，当前设备没有可用的离线副本。", "permission-denied": "当前账号没有访问这份乐谱的权限。请返回云盘确认成员关系。", "network-unavailable": "网络暂时不可用，且当前设备没有这份乐谱的离线副本。", "service-unavailable": "服务暂时不可用或返回内容异常，请稍后重试；本机内容仍然保留。", missing: "这份乐谱不存在或已经被永久移除。" }[state];
}
function scoreFromOffline(record: OfflineScoreRecord): ScoreSummary {
  return { id: record.scoreId, choirId: record.choirId, fileName: record.fileName, updatedAt: record.verifiedAt, currentVersion: { id: record.versionId, versionNumber: 1, sizeBytes: record.blob.size, sha256: record.imageManifest?.sourceSha256 ?? record.sha256, etag: "offline", pageCount: record.pageCount, createdAt: record.verifiedAt } };
}
