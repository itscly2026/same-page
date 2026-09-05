import { DiagnosticResponseError, diagnosticFetch, parseDiagnosticResponse, pdfFailureCategory, recordFailure } from "../diagnostics/diagnostics";
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
import type { PDFDocumentProxy } from "./pdf-document";

type CloudLookup = { state: "active"; score: ScoreSummary } | { state: "trashed" | "permission-denied" | "missing" | "network-unavailable" | "service-unavailable" };
type Source = { kind: "cloud" | "offline"; versionId?: string };
export interface ReaderSessionSnapshot {
  score: ScoreSummary | null;
  document: PDFDocumentProxy | null;
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
  private cloudInvalidated = false;
  private lookup: CloudLookup | null = null;
  private layerTask: Promise<void> | null = null;
  private refreshTask: Promise<void> | null = null;
  private readonly identity: string;

  constructor(readonly workspace: LocalWorkspace, private authenticatedUserId: string | null) {
    this.identity = authenticatedUserId ?? "guest";
    const score = peekReaderScore(this.identity, workspace.choirId, workspace.scoreId);
    this.confirmedVersion = score?.currentVersion.id ?? null;
    this.state = { score, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null };
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
  refresh = () => {
    if (this.disposed || !navigator.onLine || globalThis.document.visibilityState === "hidden") return Promise.resolve();
    this.refreshTask ??= this.confirmCloud().finally(() => { this.refreshTask = null; });
    return this.refreshTask;
  };
  private localMatches() { return !!this.state.offline && (!this.confirmedVersion ? this.cloudSettled : this.confirmedVersion === this.state.offline.versionId); }
  private async confirmCloud() {
    const sequence = ++this.lookupSequence;
    const lookup = await lookupScore(this.workspace);
    if (!await this.current() || sequence < this.appliedLookup) return;
    const unavailable = lookup.state === "network-unavailable" || lookup.state === "service-unavailable";
    if (!unavailable) this.appliedLookup = sequence;
    this.cloudSettled = true;
    this.lookup = lookup;
    if (lookup.state === "active") {
      this.confirmedVersion = lookup.score.currentVersion.id;
      rememberReaderScore(this.identity, lookup.score);
      this.publish({ score: lookup.score, cloudState: "active", error: null });
      const confirmation = confirmReaderDocumentVersion({ ...this.workspace, sourceKind: "cloud", versionId: this.confirmedVersion });
      if (this.source?.kind === "offline" && this.source.versionId === this.confirmedVersion) {
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
    const data = await offline.blob.arrayBuffer();
    if (!await this.current() || generation !== this.generation || !this.localMatches()) return;
    if (this.state.cloudState !== "active") this.publish({ score: scoreFromOffline(offline) });
    this.openSource({ kind: "offline", versionId: offline.versionId }, data);
  }
  private openSource(source: Source, data?: ArrayBuffer) {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.lease?.release();
    this.source = source;
    if (source.kind === "cloud") this.cloudInvalidated = false;
    this.pdfFailed = false;
    this.publish({ document: null, status: "loading", error: null });
    markLoadingJourneyMilestone("open-score", "pdf-task-start");
    const lease = acquireReaderDocument({ ...this.workspace, source: data ?? cloudPdfSource(this.workspace, source.versionId), sourceKind: source.kind, versionId: source.versionId });
    this.lease = lease;
    void lease.promise.then(async (document) => {
      if (!await this.current() || generation !== this.generation) return;
      this.publish({ document, status: "ready" });
      this.resolveFailure();
    }).catch((error) => {
      if (this.disposed || generation !== this.generation) return;
      recordFailure({ operation: "pdf", category: pdfFailureCategory(error), stage: "decode" });
      if (error instanceof ReaderDocumentVersionMismatchError && source.kind === "cloud" && source.versionId !== error.expectedVersionId) {
        this.openSource({ kind: "cloud", versionId: error.expectedVersionId });
        return;
      }
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
      const response = await diagnosticFetch(`${scorePath(this.workspace)}/layers`);
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
      const offline = await prepareOfflineScore(this.workspace, this.state.score);
      if (!await this.current()) return;
      this.publish({ offline, downloadMessage: "离线副本已完整校验，可以离线打开。" });
      if (this.source?.kind === "offline" && this.localMatches()) await this.openOffline(offline);
    } catch {
      this.publish({ downloadMessage: "离线下载未完成，现有离线版本没有切换。请重试。" });
    } finally { this.publish({ downloading: false }); }
  };
  dispose() {
    this.disposed = true;
    this.generation++;
    this.lease?.release();
    this.lease = null;
    this.listeners.clear();
  }
}
function scorePath(workspace: LocalWorkspace) { return `/api/choirs/${encodeURIComponent(workspace.choirId)}/scores/${encodeURIComponent(workspace.scoreId)}`; }
function cloudPdfSource(workspace: LocalWorkspace, versionId?: string) { return versionId ? `${scorePath(workspace)}/versions/${encodeURIComponent(versionId)}/pdf` : `${scorePath(workspace)}/pdf`; }
async function lookupScore(workspace: LocalWorkspace): Promise<CloudLookup> {
  try {
    const response = await diagnosticFetch(`${scorePath(workspace)}/bootstrap`);
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
  return { id: record.scoreId, choirId: record.choirId, fileName: record.fileName, updatedAt: record.verifiedAt, currentVersion: { id: record.versionId, versionNumber: 1, sizeBytes: record.blob.size, sha256: record.sha256, etag: "offline", pageCount: record.pageCount, createdAt: record.verifiedAt } };
}
