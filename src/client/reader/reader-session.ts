import { ReaderPresentation } from "./reader-presentation";
import { offlinePreparationDescription } from "../offline/offline-score-status";
import { offlineScoreSummary as scoreFromOffline } from "../offline/retained-scores";
import { revokeOfflinePreparationIdentity, OfflinePreparation, type OfflinePreparationState } from "../offline/offline-score";
import { liveQuery } from "dexie";
import { captureOfflineFileFence } from "../offline/local-files";
import { DiagnosticResponseError, diagnosticFetch, parseDiagnosticResponse, pdfFailureCategory, pdfFailureReason, pdfEngineVersion, recordFailure } from "../diagnostics/diagnostics";
import { readerScoreBootstrapSchema, type ScoreSummary } from "../../shared/scores";
import { restoreOfflineAnnotationSnapshot } from "../annotations/annotation-state";
import { syncAnnotations } from "../annotations/sync";
import { type OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { readOfflineFileBytes, findVerifiedOfflineScore } from "../offline/offline-score-verification";
import { markLoadingJourneyMilestone } from "../performance/loading-performance";
import { acquireReaderDocument, confirmReaderDocumentVersion, invalidateReaderDocument, ReaderDocumentVersionMismatchError, type ReaderDocumentLease } from "./reader-document-cache";
import { peekReaderScore, rememberReaderScore, forgetReaderScore } from "./reader-score-cache";
import { ImageDocument, prepareImageManifest, type ScoreDocument } from "./image-document";
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
  preparation: OfflinePreparationState;
}

// One lifetime owns source arbitration, capability preparation and document leases.
// Rendering and annotation editing remain independent consumers of this session.
export class ReaderSession {
  private state: ReaderSessionSnapshot;
  private listeners = new Set<() => void>();
  private disposed = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private localPriorityTimer: ReturnType<typeof setTimeout> | null = null;
  private localPriorityExpired = false;
  private abort = new AbortController();
  private displayAbort = new AbortController();
  private started = false;
  private source: Source | null = null;
  private lease: ReaderDocumentLease | null = null;
  private generation = 0;
  private displayPrepared = false;
  readonly presentation = new ReaderPresentation({
    confirmed: () => {
      if (!this.displayPrepared) return false;
      if (this.deadline) clearTimeout(this.deadline);
      this.retained?.lease?.release();
      this.retained = null;
      return true;
    },
    recover: reason => { this.recoverDisplay(reason); },
  });
  private retained: { document: ScoreDocument; mode: ScoreDisplayMode; source: Source | null; lease: ReaderDocumentLease | null } | null = null;
  private retainDisplay() {
    if (this.retained || !this.state.document || !this.presentation.hasPresented(this.state.document) || this.cloudInvalidated) return;
    this.retained = { document: this.state.document, mode: this.state.mode, source: this.source, lease: this.lease };
    this.lease = null;
  }
  private restoreDisplay() {
    if (!this.retained) return false;
    const previous = this.retained;
    this.displayAbort.abort();
    this.generation++;
    this.lease?.release();
    this.lease = previous.lease;
    this.source = previous.source;
    this.retained = null;
    this.displayPrepared = true;
    this.pdfFailed = false;
    if (this.deadline) clearTimeout(this.deadline);
    this.publish({ document: previous.document, mode: previous.mode, status: "ready", error: null, modeMessage: "显示恢复未完成，已保留原谱面。" });
    return true;
  }
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
  private preparation: OfflinePreparation | null = null;
  private readonly identity: string;
  private fileFence: Promise<string>;
  private filesCleared = false;
  private fileWatcher?: { unsubscribe(): void };

  constructor(readonly workspace: LocalWorkspace, private authenticatedUserId: string | null, private authenticatedSessionId: string | null = null) {
    this.fileFence = captureOfflineFileFence(workspace);
    void this.fileFence.catch(() => undefined);
    this.identity = workspace.ownerKey.startsWith("user:") ? workspace.ownerKey.slice(5) : "guest";
    const score = peekReaderScore(this.identity, workspace.choirId, workspace.scoreId);
    this.confirmedVersion = score?.currentVersion.id ?? null;
    this.state = { mode: "pdf", modeMessage: null, score, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null, preparation: { phase: "idle" } };
  }
  setAuthenticatedUser = (userId: string | null, sessionId: string | null = null) => {
    if (this.authenticatedUserId === userId && this.authenticatedSessionId === sessionId) return;
    if (this.authenticatedUserId) revokeOfflinePreparationIdentity(this.authenticatedUserId);
    this.authenticatedUserId = userId;
    this.authenticatedSessionId = sessionId;
    this.layerAbort.abort();
    this.releasePreparation();
    this.layerAbort = new AbortController();
    if (this.started) void Promise.resolve(this.layerTask).then(() => this.refresh());
  };
  private layerAbort = new AbortController();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ReaderSessionSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    if ("document" in patch) this.presentation.load(patch.document ?? null);
    this.listeners.forEach((listener) => listener());
  }
  private async current() { return !this.disposed && await assertLocalWorkspaceActive(this.workspace).then(() => true, () => false) && !this.disposed; }
  open() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.fileWatcher = liveQuery(() => captureOfflineFileFence(this.workspace)).subscribe({ next: current => {
      void this.fileFence.then(initial => {
        if (current === initial || this.disposed) return;
        this.filesCleared = true;
        this.releasePreparation();
        this.publish({ offline: null, downloadMessage: "本机谱面文件已清理。当前谱面可继续阅读，再次打开时可重新下载。" });
      }).catch(() => undefined);
    }, error: () => undefined });
    this.armDeadline();
    this.publish({});
    // Give a verified local copy first choice without letting slow local storage
    // block online reading. Late local results still follow version arbitration.
    this.localPriorityTimer = setTimeout(() => {
      this.localPriorityExpired = true;
      this.startCloudIfNeeded();
    }, 100);
    void findVerifiedOfflineScore(this.workspace).catch(() => null).then(async (offline) => {
      if (!await this.current()) return;
      this.publish({ offline });
      this.localSettled = true;
      if (offline) {
        if ((!navigator.onLine || this.lookup?.state === "network-unavailable") && offline.imageManifest) this.publish({ mode: "images" });
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
      this.startCloudIfNeeded();
      this.resolveFailure();
      this.prepareAutomaticOfflineCopy();
    });
    void this.confirmCloud();
  }
  private startCloudIfNeeded() {
    if (!this.disposed && !this.source && (!this.cloudSettled || this.lookup?.state === "active" || this.confirmedVersion)) {
      this.openSource({ kind: "cloud", versionId: this.confirmedVersion ?? undefined });
    }
  }
  private armDeadline() {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      if (this.retained) { this.restoreDisplay(); return; }
      if (this.state.status === "loading" || !this.state.score || !this.presentation.hasPresented(this.state.document)) {
        recordFailure({ operation: "pdf", category: "internal", stage: "prepare",
          step: this.state.document ? "reader-presentation" : this.source ? "reader-document" : "reader-source", errorType: "TimeoutError", pdfReason: "timeout" });
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
  private localMatches() { return !!this.state.offline && (!this.confirmedVersion || this.confirmedVersion === this.state.offline.versionId) && (this.state.offline.imageManifest ? "images" : "pdf") === this.state.mode; }
  private async confirmCloud() {
    const sequence = ++this.lookupSequence;
    const lookup = await lookupScore(this.workspace, this.abort.signal);
    if (!await this.current() || sequence < this.appliedLookup) return;
    const unavailable = lookup.state === "network-unavailable" || lookup.state === "service-unavailable";
    if (!unavailable) this.appliedLookup = sequence;
    this.cloudSettled = true;
    this.lookup = lookup;
    if (lookup.state === "active") {
      if (this.confirmedVersion !== lookup.score.currentVersion.id) this.releasePreparation();
      this.confirmedVersion = lookup.score.currentVersion.id;
      rememberReaderScore(this.identity, lookup.score);
      this.publish({ score: lookup.score, downloadMessage: this.state.score?.currentVersion.id === lookup.score.currentVersion.id ? this.state.downloadMessage : null, cloudState: "active", ...(this.pdfFailed ? {} : { error: null }) });
      const confirmation = confirmReaderDocumentVersion({ ...this.workspace, sourceKind: "cloud", versionId: this.confirmedVersion });
      if (!this.localSettled && !this.localPriorityExpired) {
        // Inspect the verified local copy before starting a competing cloud PDF.
      } else if ((this.source?.kind === "offline" || this.state.mode === "images") && this.source?.versionId === this.confirmedVersion) {
        // A matching offline document already owns the display lease.
      } else if (this.localMatches() && !this.state.document) {
        await this.openOffline(this.state.offline!);
      } else if ((confirmation !== "match" || this.source?.kind !== "cloud") && !(this.pdfFailed && !this.cloudInvalidated && this.source?.kind === "cloud" && (!this.source.versionId || this.source.versionId === this.confirmedVersion))) {
        this.openSource({ kind: "cloud", versionId: this.confirmedVersion });
      }
      void this.retryLayers();
    } else {
      if (!unavailable) {
        this.releasePreparation();
        this.cloudInvalidated = true;
        this.confirmedVersion = null;
        forgetReaderScore(this.identity, this.workspace.choirId, this.workspace.scoreId);
        invalidateReaderDocument({ ...this.workspace, sourceKind: "cloud" });
      }
      this.publish({ cloudState: lookup.state === "trashed" ? "trashed" : "unavailable", ...(lookup.state === "trashed" ? { capability: "trashed" as const } : {}) });
      if (lookup.state === "network-unavailable" && this.state.offline?.imageManifest && !this.state.document) this.publish({ mode: "images" });
      if (this.localMatches()) void this.openOffline(this.state.offline!);
      if (lookup.state !== "trashed") void this.retryLayers();
    }
    this.resolveFailure();
    this.prepareAutomaticOfflineCopy();
  }
  private async openOffline(offline: OfflineScoreRecord) {
    if (this.source?.kind === "offline" && this.source.versionId === offline.versionId) return;
    const generation = this.generation;
    let data: ArrayBuffer | undefined;
    try { data = offline.imageManifest ? undefined : await readOfflineFileBytes(offline.blob); }
    catch {
      if (!await this.current() || generation !== this.generation) return;
      this.publish({ offline: null, downloadMessage: "本机谱面读取失败，请重新下载；本机笔记仍然保留。" });
      this.startCloudIfNeeded();
      this.resolveFailure();
      return;
    }
    if (!await this.current() || generation !== this.generation || !this.localMatches()) return;
    if (this.state.cloudState !== "active") this.publish({ score: scoreFromOffline(offline) });
    this.openSource({ kind: "offline", versionId: offline.versionId }, data);
  }
  private openSource(source: Source, data?: ArrayBuffer) {
    if (this.disposed) return;
    if (this.state.mode === "images" && source.kind === "cloud" && !this.state.score) return;
    this.retainDisplay();
    this.displayPrepared = false;
    if (this.source) this.armDeadline();
    this.displayAbort.abort();
    this.displayAbort = new AbortController();
    const generation = ++this.generation;
    this.lease?.release();
    this.source = source;
    const document = this.cloudInvalidated ? null : this.state.document;
    if (source.kind === "cloud") this.cloudInvalidated = false;
    this.pdfFailed = false;
    this.publish({ document, status: document ? "ready" : "loading", error: null });
    if (this.state.mode === "images") {
      const score = this.state.score!;
      const local = source.kind === "offline" ? this.state.offline : null;
      const signal = this.displayAbort.signal;
      const manifest = local?.imageManifest
        ? Promise.resolve(local.imageManifest)
        : prepareImageManifest(this.workspace, source.versionId!, score.currentVersion.sha256, signal);
      void manifest.then(async manifest => {
        if (!await this.current() || generation !== this.generation) return;
        this.displayPrepared = true;
        this.publish({ document: new ImageDocument(manifest, scoreImagesPath(this.workspace.choirId, this.workspace.scoreId, manifest.versionId), local?.blob), status: "ready", modeMessage: this.automaticRecoveryUsed ? "PDF 显示失败，当前使用图片恢复。" : null });
        this.prepareAutomaticOfflineCopy();
      }).catch(error => {
        if (this.disposed || generation !== this.generation) return;
        recordFailure({ operation: "pdf", category: pdfFailureCategory(error), stage: "prepare" });
        if (this.restoreDisplay()) return;
        this.publish({ status: "error", error: "图片兼容模式准备失败，可以重试或选择 PDF 阅读。本机草稿仍然保留。" });
      });
      return;
    }
    markLoadingJourneyMilestone("open-score", "pdf-task-start");
    const lease = acquireReaderDocument({ ...this.workspace, source: data ?? cloudPdfSource(this.workspace, source.versionId), sourceKind: source.kind, versionId: source.versionId });
    this.lease = lease;
    void lease.promise.then(async (document) => {
      if (!await this.current() || generation !== this.generation) return;
      this.displayPrepared = true;
      this.publish({ document, status: "ready", modeMessage: null });
      this.resolveFailure();
      this.prepareAutomaticOfflineCopy();
    }).catch((error) => {
      if (this.disposed || generation !== this.generation) return;
      recordFailure({ operation: "pdf", category: pdfFailureCategory(error), stage: "decode", pdfReason: pdfFailureReason(error), engineVersion: pdfEngineVersion });
      if (error instanceof ReaderDocumentVersionMismatchError && source.kind === "cloud" && source.versionId !== error.expectedVersionId) {
        this.openSource({ kind: "cloud", versionId: error.expectedVersionId });
        return;
      }
      if (this.recoverDisplay(error)) return;
      if (this.restoreDisplay()) return;
      this.pdfFailed = true;
      this.resolveFailure();
    });
  }
  private resolveFailure() {
    if (!this.localSettled || !this.cloudSettled || this.disposed) return;
    if (this.lookup && this.lookup.state !== "active" && !this.localMatches() && !this.confirmedVersion) {
      this.publish({ status: "error", error: failureMessage(this.lookup.state) });
    } else if (this.pdfFailed) {
      this.publish({ status: "error", error: this.source?.kind === "offline" ? "本机离线副本无法解析，现有笔记仍然保留。" : "PDF 无法解析或文件暂时不可用。" });
    }
  }
  retryLayers = () => {
    if (this.disposed || this.getSnapshot().cloudState === "trashed") return Promise.resolve();
    this.layerTask ??= this.prepareLayers().finally(() => { this.layerTask = null; });
    return this.layerTask;
  };
  private async prepareLayers() {
    if (this.state.capability !== "ready") this.publish({ capability: "preparing" });
    let layersApplied = false;
    try {
      if (this.workspace.ownerKey.startsWith("user:") && this.workspace.ownerKey !== `user:${this.authenticatedUserId ?? ""}`) throw new Error("layer_identity_mismatch");
      await syncAnnotations(this.workspace, {
        pull: true, freshLayers: false, signal: AbortSignal.any([this.abort.signal, this.layerAbort.signal]),
        onLayersApplied: layers => {
          if (this.disposed || this.state.cloudState === "trashed") return;
          layersApplied = true;
          this.publish({ capability: layers.some(layer => layer.canEdit) ? "ready" : "read-only" });
        },
      });
    } catch {
      if (layersApplied || !await this.current() || this.getSnapshot().cloudState === "trashed") return;
      this.publish({ capability: this.state.offline ? (this.state.offline.annotationSnapshot.layers.some((layer) => layer.canEdit) ? "ready" : "read-only") : "failed" });
    }
  }
  private releasePreparation() {
    this.preparation?.dispose();
    this.preparation = null;
    this.publish({ downloading: false, preparation: { phase: "idle" } });
  }
  private offlinePreparation() {
    const score = this.state.score!;
    if (!this.preparation) {
      const preparation = new OfflinePreparation(this.workspace, score, this.state.mode, this.authenticatedUserId, this.fileFence);
      this.preparation = preparation;
      preparation.subscribe(() => {
        if (this.preparation !== preparation || this.disposed) return;
        const state = preparation.getSnapshot();
        this.publish({ preparation: state, downloading: state.phase === "preparing",
          downloadMessage: state.phase === "ready" ? "离线副本已完整校验，可以离线打开。"
            : state.phase === "failed" ? offlinePreparationDescription(state, { record: this.state.offline, invalid: false }, this.state.score?.currentVersion.id ?? "", this.state.mode) : null,
          ...(state.phase === "ready" ? { offline: state.record } : {}),
        });
      });
    }
    return this.preparation;
  }
  private prepareAutomaticOfflineCopy() {
    if (this.filesCleared || !this.started || !this.localSettled || this.state.cloudState !== "active" ||
        !this.displayPrepared || !navigator.onLine || this.disposed || this.localMatches()) return;
    void this.prepareOffline("automatic");
  }
  private prepareOffline(intent: "automatic" | "explicit") {
    if (this.disposed || !this.state.score || this.state.cloudState !== "active") return Promise.resolve();
    const document = this.state.document;
    const pdfData = this.state.mode === "pdf" && this.displayPrepared && this.source?.versionId === this.state.score.currentVersion.id && document && "getData" in document
      ? () => document.getData() : undefined;
    return this.offlinePreparation().prepare(intent, pdfData);
  }
  download = () => {
    if (this.filesCleared) {
      this.releasePreparation();
      this.fileFence = captureOfflineFileFence(this.workspace);
      this.filesCleared = false;
    }
    return this.prepareOffline("explicit");
  };
  recoverDisplay = (error: unknown) => {
    if (!this.disposed && this.restoreDisplay()) return true;
    if (this.disposed || this.state.mode !== "pdf" || this.automaticRecoveryUsed || !navigator.onLine || !isRecoverablePdfFailure(error)) return false;
    this.automaticRecoveryUsed = true;
    if (!this.changeMode("images")) return false;
    this.publish({ modeMessage: "PDF 显示失败，已尝试图片兼容模式。你仍可切回 PDF 阅读。" });
    return true;
  };
  retryPdf = () => {
    if (this.state.mode !== "images" || !this.state.document) return false;
    this.changeMode("pdf");
    return true;
  };
  private changeMode(mode: ScoreDisplayMode) {
    if (this.disposed) return false;
    if (mode === this.state.mode) {
      return false;
    }
    if ((!navigator.onLine || this.lookup?.state === "network-unavailable") && (!this.state.offline || (this.state.offline.imageManifest ? "images" : "pdf") !== mode)) {
      this.publish({ modeMessage: `本机没有${mode === "images" ? "图片" : "PDF"}离线副本，请联网后下载。当前副本仍可使用。` });
      return false;
    }
    this.retainDisplay();
    this.releasePreparation();
    this.displayPrepared = false;
    this.displayAbort.abort();
    this.generation++;
    this.lease?.release();
    this.lease = null;
    this.source = null;
    this.pdfFailed = false;
    this.publish({ mode, downloadMessage: null, modeMessage: this.state.document ? "正在准备新的显示方式，原谱面继续保留…" : null, status: this.state.document ? "ready" : "loading", error: null });
    this.armDeadline();
    if (this.localMatches()) void this.openOffline(this.state.offline!);
    else if (this.confirmedVersion) this.openSource({ kind: "cloud", versionId: this.confirmedVersion });
    else void this.confirmCloud();
    this.prepareAutomaticOfflineCopy();
    return true;
  }
  cancel = () => {
    this.publish({ status: "error", error: "加载已取消，本机草稿仍然保留。" });
    invalidateReaderDocument({ ...this.workspace });
    this.dispose();
  };
  dispose() {
    this.releasePreparation();
    this.disposed = true;
    this.fileWatcher?.unsubscribe();
    if (this.deadline) clearTimeout(this.deadline);
    if (this.localPriorityTimer) clearTimeout(this.localPriorityTimer);
    this.abort.abort();
    this.displayAbort.abort();
    this.generation++;
    this.lease?.release();
    this.lease = null;
    this.retained?.lease?.release();
    this.retained = null;
    this.presentation.dispose();
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

export function isRecoverablePdfFailure(error: unknown) {
  return pdfFailureCategory(error) !== "network" && error instanceof Error && ["PdfEngineUnavailableError", "InvalidPDFException", "FormatError", "UnknownErrorException", "PdfPageRenderError"].includes(error.name);
}
