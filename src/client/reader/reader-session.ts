import { isLocalExperience } from "../annotations/guest-notes";
import { ReaderPresentation } from "./reader-presentation";
import { offlinePreparationDescription } from "../offline/offline-score-status";
import { offlineScoreSummary as scoreFromOffline } from "../offline/retained-scores";
import { revokeOfflinePreparationIdentity, OfflinePreparation, type OfflinePreparationState } from "../offline/offline-score";
import { liveQuery } from "dexie";
import { captureOfflineFileFence } from "../offline/local-files";
import { DiagnosticResponseError, pdfFailureCategory, pdfFailureReason, pdfEngineVersion, recordFailure } from "../diagnostics/diagnostics";
import { type ScoreSummary } from "../../shared/scores";
import { restoreOfflineAnnotationSnapshot } from "../annotations/annotation-state";
import { syncReader, subscribeReaderSync, ReaderSyncError } from "./sync-reader";
import type { ReaderSyncResponse } from "../../shared/reader-sync";
import { type OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import { readOfflineFileBytes, findVerifiedOfflineScore } from "../offline/offline-score-verification";
import { markLoadingJourneyMilestone } from "../performance/loading-performance";
import { acquireReaderDocument, confirmReaderDocumentVersion, invalidateReaderDocument, ReaderDocumentVersionMismatchError, type ReaderDocumentLease } from "./reader-document-cache";
import { peekReaderScore, rememberReaderScore, forgetReaderScore } from "./reader-score-cache";
import type { PDFDocumentProxy } from "./pdf-document";

type CloudLookup = { state: "active"; score: ScoreSummary } | { state: "trashed" | "permission-denied" | "missing" | "network-unavailable" | "service-unavailable" };
type Source = { kind: "cloud" | "offline"; versionId?: string };
export interface ReaderSessionSnapshot {
  score: ScoreSummary | null;
  document: PDFDocumentProxy | null;
  displayMessage: string | null;
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
    recover: () => { this.restoreDisplay(); },
  });
  private retained: { document: PDFDocumentProxy; source: Source | null; lease: ReaderDocumentLease | null } | null = null;
  private retainDisplay() {
    if (this.retained || !this.state.document || !this.presentation.hasPresented(this.state.document) || this.cloudInvalidated) return;
    this.retained = { document: this.state.document, source: this.source, lease: this.lease };
    this.lease = null;
  }
  private restoreDisplay() {
    if (!this.retained) return false;
    const previous = this.retained;
    this.generation++;
    this.lease?.release();
    this.lease = previous.lease;
    this.source = previous.source;
    this.retained = null;
    this.displayPrepared = true;
    this.pdfFailed = false;
    if (this.deadline) clearTimeout(this.deadline);
    this.publish({ document: previous.document, status: "ready", error: null, displayMessage: "显示恢复未完成，已保留原谱面。" });
    return true;
  }
  private lookupSequence = 0;
  private appliedLookup = 0;
  private confirmedVersion: string | null;
  private localSettled = false;
  private cloudSettled = false;
  private pdfFailed = false;
  private pdfError: string | null = null;
  private cloudInvalidated = false;
  private lookup: CloudLookup | null = null;
  private unsubscribeSync?: () => void;
  private refreshTask: Promise<void> | null = null;
  private preparation: OfflinePreparation | null = null;
  private readonly identity: string;
  private fileFence: Promise<string>;
  private filesCleared = false;
  private fileWatcher?: { unsubscribe(): void };

  constructor(readonly workspace: LocalWorkspace, private authenticatedUserId: string | null, private authenticatedSessionId: string | null = null) {
    this.fileFence = captureOfflineFileFence(workspace);
    void this.fileFence.catch(() => undefined);
    this.identity = workspace.ownerKey.startsWith("user:") ? workspace.ownerKey.slice(5) : workspace.ownerKey.startsWith("experience:") ? workspace.ownerKey : "guest";
    const score = peekReaderScore(this.identity, workspace.choirId, workspace.scoreId);
    this.confirmedVersion = score?.currentVersion.id ?? null;
    this.state = { displayMessage: null, score, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null, preparation: { phase: "idle" } };
  }
  setAuthenticatedUser = (userId: string | null, sessionId: string | null = null) => {
    if (this.authenticatedUserId === userId && this.authenticatedSessionId === sessionId) return;
    if (this.authenticatedUserId) revokeOfflinePreparationIdentity(this.authenticatedUserId);
    this.authenticatedUserId = userId;
    this.authenticatedSessionId = sessionId;
    this.layerAbort.abort();
    this.releasePreparation();
    this.layerAbort = new AbortController();
    if (this.started) void Promise.resolve(this.refreshTask).then(() => this.refresh());
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
    this.unsubscribeSync = subscribeReaderSync(this.workspace, result => this.applyCloud(result));
    if (navigator.onLine) void this.refresh();
    else void this.applyCloud({ state: "network-unavailable" });
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
    }, 45_000);
  }
  refresh = () => {
    if (this.disposed || !navigator.onLine) return Promise.resolve();
    this.refreshTask ??= this.confirmCloud().finally(() => { this.refreshTask = null; });
    return this.refreshTask;
  };
  private localMatches() { return !!this.state.offline && (!this.confirmedVersion || this.confirmedVersion === this.state.offline.versionId); }
  private async confirmCloud() {
    try { await syncReader(this.workspace, { push: false, signal: AbortSignal.any([this.abort.signal, this.layerAbort.signal]) }); }
    catch (error) {
      if (this.disposed || this.layerAbort.signal.aborted || this.state.cloudState !== "checking") return;
      await this.applyCloud({ state: error instanceof ReaderSyncError
        ? error.status === 401 || error.status === 403 ? "permission-denied" : error.status >= 500 ? "service-unavailable" : "missing"
        : error instanceof DiagnosticResponseError ? "service-unavailable" : "network-unavailable" });
    }
  }
  private async applyCloud(lookup: CloudLookup | ReaderSyncResponse) {
    const sequence = ++this.lookupSequence;
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
      } else if (this.source?.kind === "offline" && this.source?.versionId === this.confirmedVersion) {
        // A matching offline document already owns the display lease.
      } else if (this.localMatches() && !this.state.document) {
        await this.openOffline(this.state.offline!);
      } else if ((confirmation !== "match" || this.source?.kind !== "cloud") && !(this.pdfFailed && !this.cloudInvalidated && this.source?.kind === "cloud" && (!this.source.versionId || this.source.versionId === this.confirmedVersion))) {
        this.openSource({ kind: "cloud", versionId: this.confirmedVersion });
      }
      if ("layers" in lookup) this.publish({ capability: lookup.layers.layers.some(layer => layer.canEdit) || isLocalExperience(this.workspace) ? "ready" : "read-only" });
    } else {
      if (!unavailable) {
        this.releasePreparation();
        this.cloudInvalidated = true;
        this.confirmedVersion = null;
        forgetReaderScore(this.identity, this.workspace.choirId, this.workspace.scoreId);
        invalidateReaderDocument({ ...this.workspace, sourceKind: "cloud" });
      }
      this.publish({ cloudState: lookup.state === "trashed" ? "trashed" : "unavailable", ...(lookup.state === "trashed" ? { capability: "trashed" as const } : {}) });
      if (this.localMatches()) void this.openOffline(this.state.offline!);
      this.publish({ capability: lookup.state === "trashed" ? "trashed" : this.state.offline ? this.state.capability : "failed" });
    }
    this.resolveFailure();
    this.prepareAutomaticOfflineCopy();
  }
  private async openOffline(offline: OfflineScoreRecord) {
    if (this.source?.kind === "offline" && this.source.versionId === offline.versionId) return;
    const generation = this.generation;
    let data: ArrayBuffer | undefined;
    try { data = await readOfflineFileBytes(offline.blob); }
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
    this.retainDisplay();
    this.displayPrepared = false;
    if (this.source) this.armDeadline();
    const generation = ++this.generation;
    this.lease?.release();
    this.source = source;
    const document = this.cloudInvalidated ? null : this.state.document;
    if (source.kind === "cloud") this.cloudInvalidated = false;
    this.pdfFailed = false;
    this.publish({ document, status: document ? "ready" : "loading", error: null });
    markLoadingJourneyMilestone("open-score", "pdf-task-start");
    const lease = acquireReaderDocument({ ...this.workspace, source: data ?? cloudPdfSource(this.workspace, source.versionId), sourceKind: source.kind, versionId: source.versionId });
    this.lease = lease;
    void lease.promise.then(async (document) => {
      if (!await this.current() || generation !== this.generation) return;
      this.displayPrepared = true;
      this.publish({ document, status: "ready", displayMessage: null });
      this.resolveFailure();
      this.prepareAutomaticOfflineCopy();
    }).catch((error) => {
      if (this.disposed || generation !== this.generation) return;
      recordFailure({ operation: "pdf", category: pdfFailureCategory(error), stage: "decode", pdfReason: pdfFailureReason(error), engineVersion: pdfEngineVersion });
      if (error instanceof ReaderDocumentVersionMismatchError && source.kind === "cloud" && source.versionId !== error.expectedVersionId) {
        this.openSource({ kind: "cloud", versionId: error.expectedVersionId });
        return;
      }
      if (this.restoreDisplay()) return;
      this.pdfFailed = true;
      this.pdfError = pdfErrorMessage(error, source.kind);
      this.resolveFailure();
    });
  }
  private resolveFailure() {
    if (!this.localSettled || !this.cloudSettled || this.disposed) return;
    if (this.lookup && this.lookup.state !== "active" && !this.localMatches() && !this.confirmedVersion) {
      this.publish({ status: "error", error: failureMessage(this.lookup.state) });
    } else if (this.pdfFailed) {
      this.publish({ status: "error", error: this.pdfError });
    }
  }
  retryLayers = () => this.refresh();
  private releasePreparation() {
    this.preparation?.dispose();
    this.preparation = null;
    this.publish({ downloading: false, preparation: { phase: "idle" } });
  }
  private offlinePreparation() {
    const score = this.state.score!;
    if (!this.preparation) {
      const preparation = new OfflinePreparation(this.workspace, score, this.authenticatedUserId, this.fileFence);
      this.preparation = preparation;
      preparation.subscribe(() => {
        if (this.preparation !== preparation || this.disposed) return;
        const state = preparation.getSnapshot();
        this.publish({ preparation: state, downloading: state.phase === "preparing",
          downloadMessage: state.phase === "ready" ? "离线副本已完整校验，可以离线打开。"
            : state.phase === "failed" ? offlinePreparationDescription(state, { record: this.state.offline, invalid: false }, this.state.score?.currentVersion.id ?? "") : null,
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
    const pdfData = this.displayPrepared && this.source?.versionId === this.state.score.currentVersion.id && document && "getData" in document
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
    this.generation++;
    this.lease?.release();
    this.lease = null;
    this.retained?.lease?.release();
    this.retained = null;
    this.presentation.dispose();
    this.unsubscribeSync?.();
    this.listeners.clear();
  }
}
function scorePath(workspace: LocalWorkspace) { return `/api/choirs/${encodeURIComponent(workspace.choirId)}/scores/${encodeURIComponent(workspace.scoreId)}`; }
function cloudPdfSource(workspace: LocalWorkspace, versionId?: string) { return versionId ? `${scorePath(workspace)}/versions/${encodeURIComponent(versionId)}/pdf` : `${scorePath(workspace)}/pdf`; }
function failureMessage(state: Exclude<CloudLookup["state"], "active">) {
  return { trashed: "这份乐谱已移入回收站，当前设备没有可用的离线副本。", "permission-denied": "当前账号没有访问这份乐谱的权限。请返回云盘确认成员关系。", "network-unavailable": "网络暂时不可用，且当前设备没有这份乐谱的离线副本。", "service-unavailable": "服务暂时不可用或返回内容异常，请稍后重试；本机内容仍然保留。", missing: "这份乐谱不存在或已经被永久移除。" }[state];
}

function pdfErrorMessage(error: unknown, source: Source["kind"]) {
  const reason = pdfFailureReason(error);
  if (reason === "engine-unavailable") return "当前浏览器无法启动 PDF 阅读引擎，请升级浏览器或系统，也可以下载原 PDF 阅读。本机笔记仍然保留。";
  const category = pdfFailureCategory(error);
  if (category === "permission") return "当前无法访问这份 PDF，请返回云盘确认登录状态和权限。";
  if (category === "network") return "PDF 下载失败，请检查网络后重试。本机笔记仍然保留。";
  if (error instanceof Error && error.name === "PasswordException") return "这份 PDF 需要密码，暂时无法在这里阅读。可以下载原 PDF 打开。";
  return source === "offline" ? "本机离线副本无法解析，现有笔记仍然保留。" : "PDF 无法解析或文件暂时不可用，可以重试或下载原 PDF。";
}
