import { DisplayRecovery } from "../reader/display-recovery";
import type { ScoreDocument } from "../reader/image-document";
import "../reader/reader-ux.css";
import { useReaderSession } from "../reader/use-reader-session";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft, Download, Ellipsis, Layers, Maximize2, Minus, Pencil, Plus, BookOpen,
  RefreshCw, Rows3,
} from "lucide-react";
import {
  useEffect,
  lazy,
  useRef,
  useState,
  Suspense,
} from "react";
import {
  Button, Dialog, Modal, ModalOverlay,
} from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import {
  defaultSharedLayerSlots,
  type AnnotationLayerSummary,
} from "../../shared/annotations";
import type {
  AnnotationOverlayInteraction,
  AnnotationTool,
} from "../annotations/annotation-overlay";
import {
  cleanupUncreatedDeleteConflicts,
  readScoreAnnotationState,
  discardAnnotationConflict,
  queueScoreDrafts,
  reapplyAnnotationConflict,
  retryScoreSyncErrors,
} from "../annotations/annotation-state";
import { requestOutboxRecovery } from "../annotations/outbox-recovery";
import { syncAnnotations } from "../annotations/sync";
import {
  beginAnnotationEditSession,
  endAnnotationEditSession,
} from "../annotations/annotation-state";
import { authClient } from "../auth/auth-client";
import {
  ensureLoadingJourney,
  startLoadingJourney,
} from "../performance/loading-performance";
import {
  isLocalWorkspaceActive,
  captureLocalWorkspaceSession,
  resolveLocalWorkspace,
  type LocalWorkspace,
} from "../platform/local-workspace";
import { offlineScoreLabel, useOfflineScore } from "../offline/use-offline-score";
import { driveCacheOwnerKey } from "../score-library/drive-library-cache";
import { recordScoreOpened } from "../score-library/library-view-state";
import {
  type AnnotationPageProps,
  type ContinuousReaderPosition,
  ContinuousLayout,
  PageLayout,
  PageNavigatorPanel,
} from "../reader/reader-layouts";
import {
  type ReaderLayout,
  useReaderPreferences,
} from "../reader/use-reader-preferences";
import { usePagedReader } from "../reader/use-paged-reader";
import {
  deriveReaderSyncStatus,
  describeAnnotationConflict,
  type ReaderSyncOutcome,
} from "../reader/reader-sync-status";

type ReaderPanel = "layers" | "pages";

const ReaderEditingControls = lazy(() =>
  import("../reader/reader-editing-controls").then((module) => ({
    default: module.ReaderEditingControls,
  })),
);
const ReaderLayerPanel = lazy(() =>
  import("../reader/reader-layer-panel").then((module) => ({
    default: module.ReaderLayerPanel,
  })),
);

export default function ReaderPage() {
  const { choirId, scoreId } = useParams();
  const session = authClient.useSession();
  return <ReaderPageContent key={`${session.data?.user.id ?? "guest"}:${choirId}:${scoreId}`} />;
}

function ReaderPageContent() {
  const { choirId = "", scoreId = "" } = useParams();
  const session = authClient.useSession();
  const [resolvedWorkspace, setResolvedWorkspace] =
    useState<LocalWorkspace | null>(null);
  const workspaceIsActive = useLiveQuery(
    () => resolvedWorkspace
      ? isLocalWorkspaceActive(resolvedWorkspace)
      : false,
    [resolvedWorkspace?.scopeKey],
    false,
  );
  const [zoom, setZoom] = useState(1);
  const [editing, setEditing] = useState(false);
  const [annotationInteraction, setAnnotationInteraction] =
    useState<AnnotationOverlayInteraction>("idle");
  const [tool, setTool] = useState<AnnotationTool>("text");
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [syncOutcome, setSyncOutcome] = useState<ReaderSyncOutcome>("none");
  const [syncing, setSyncing] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [readerPanel, setReaderPanel] = useState<ReaderPanel | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editingOrigin, setEditingOrigin] = useState<{
    layout: ReaderLayout;
    page: number;
    zoom: number;
    continuousPosition: ContinuousReaderPosition | null;
  } | null>(null);
  const continuousPosition = useRef<ContinuousReaderPosition>({
    page: 1,
    pageOffsetRatio: 0,
  });
  const [continuousRestorePosition, setContinuousRestorePosition] =
    useState<ContinuousReaderPosition | null>(null);
  const [showGestureHint, setShowGestureHint] = useState(
    () => !readBooleanPreference("reader-gesture-hint-seen"),
  );
  useEffect(() => {
    ensureLoadingJourney("open-score", "direct");
  }, []);
  useEffect(() => {
    if (session.isPending) return;
    let active = true;
    void resolveLocalWorkspace({
      authenticatedUserId: session.data?.user.id ?? null,
      choirId,
      scoreId,
    }).then(async (resolved) => {
      const workspace = await captureLocalWorkspaceSession(resolved);
      try {
        await cleanupUncreatedDeleteConflicts(workspace);
      } catch {
        // Historical cleanup must never prevent the local workspace from opening.
      }
      if (active) setResolvedWorkspace(workspace);
    });
    return () => {
      active = false;
    };
  }, [choirId, scoreId, session.data?.user.id, session.isPending]);

  const workspace =
    resolvedWorkspace &&
    (!session.data?.user.id || resolvedWorkspace.ownerKey === `user:${session.data.user.id}`) &&
    workspaceIsActive &&
    resolvedWorkspace.choirId === choirId &&
    resolvedWorkspace.scoreId === scoreId
      ? resolvedWorkspace
      : null;
  const [visibleDisplay, setVisibleDisplay] = useState<ScoreDocument | null>(null);
  const [failedDisplay, setFailedDisplay] = useState<ScoreDocument | null>(null);
  const reader = useReaderSession(workspace, session.data?.user.id ?? null);
  const { score, document, offline: loadedOffline, cloudState, downloading, downloadMessage } = reader.snapshot;
  const documentScopeKey = document ? workspace?.scopeKey ?? null : null;
  const offlineStatus = useOfflineScore(workspace);
  const offline = offlineStatus?.scopeKey === workspace?.scopeKey ? offlineStatus?.record ?? loadedOffline : loadedOffline;
  const downloadOffline = reader.download;
  useEffect(() => {
    endAnnotationEditSession();
  }, [workspace?.scopeKey]);
  useEffect(() => {
    if (document && workspace && documentScopeKey === workspace.scopeKey) {
      recordScoreOpened(driveCacheOwnerKey(workspace.ownerKey.startsWith("user:") ? workspace.ownerKey.slice(5) : null, choirId), choirId, scoreId);
    }
  }, [document, documentScopeKey, workspace, choirId, scoreId, session.data?.user.id]);
  const annotationState = useLiveQuery(
    () => workspace ? readScoreAnnotationState(workspace).catch(() => null) : null,
    [workspace?.scopeKey], null,
  );
  const activeAnnotations = annotationState?.scopeKey === workspace?.scopeKey ? annotationState : null;
  const layers = [...activeAnnotations?.layers ?? []].sort(compareLayers);
  const annotations = activeAnnotations?.annotations ?? [];
  const pendingCount = activeAnnotations?.pendingCount ?? 0;
  const conflicts = activeAnnotations?.conflicts ?? [];
  const syncErrorCount = activeAnnotations?.syncErrorCount ?? 0;
  const editAvailability = reader.snapshot.capability === "ready" && !activeAnnotations?.layersReady
    ? "preparing" : reader.snapshot.capability;
  const { layout, currentPage, setLayout, setCurrentPage } =
    useReaderPreferences({
      pageCount: document?.numPages,
      identity: session.data?.user.id ?? "guest",
      choirId,
      scoreId,
    });
  const pager = usePagedReader({
    currentPage,
    pageCount: document?.numPages ?? 1,
    documentKey: `${documentScopeKey ?? "none"}:${score?.currentVersion.id ?? "none"}`,
    enabled: layout === "page" && !editing && document !== null,
    onPageChange: setCurrentPage,
  });
  const requestPage = pager.request;

  useEffect(() => {
    if (!document || !showGestureHint) return;
    try {
      localStorage.setItem("reader-gesture-hint-seen", "true");
    } catch {
      // The one-time hint may repeat when storage is unavailable.
    }
    const timer = window.setTimeout(() => setShowGestureHint(false), 3600);
    return () => window.clearTimeout(timer);
  }, [document, showGestureHint]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        layout !== "page" ||
        readerPanel !== null || moreOpen ||
        editing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setZoom(1);
        requestPage("previous");
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        setZoom(1);
        requestPage("next");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, layout, moreOpen, readerPanel, requestPage]);

  const beginEditing = () => {
    if (cloudState === "trashed") {
      setSyncOutcome("trash-preserved");
      return;
    }
    if (!workspace) return;
    const preferenceKey = `reader-edit-layer:${workspace.scopeKey}`;
    const rememberedLayerId = readStringPreference(preferenceKey);
    const editableLayer =
      layers.find((layer) => layer.id === rememberedLayerId && layer.canEdit) ??
      layers.find((layer) => layer.kind === "personal" && layer.canEdit) ??
      layers.find((layer) => layer.canEdit);
    if (!editableLayer) return;
    setEditingOrigin({
      layout,
      page: currentPage,
      zoom,
      continuousPosition:
        layout === "continuous"
          ? {
              page: currentPage,
              pageOffsetRatio:
                continuousPosition.current.page === currentPage
                  ? continuousPosition.current.pageOffsetRatio
                  : 0,
            }
          : null,
    });
    if (layout === "continuous") setLayout("page");
    setZoom(1);
    setChromeVisible(true);
    setMoreOpen(false);
    setReaderPanel(null);
    setActiveLayerId(editableLayer.id);
    writeStringPreference(preferenceKey, editableLayer.id);
    setTool("text");
    beginAnnotationEditSession();
    setEditing(true);
    setSyncOutcome("local-draft");
  };

  const requestEditing = () => {
    if (layers.some((layer) => layer.canEdit)) {
      beginEditing();
      return;
    }
    if (editAvailability === "failed") {
      void reader.retryLayers();
      return;
    }
    if (editAvailability === "ready") beginEditing();
  };

  const finishEditing = async () => {
    if (!workspace) return;
    setEditing(false);
    endAnnotationEditSession();
    if (editingOrigin) {
      setLayout(editingOrigin.layout);
      setCurrentPage(editingOrigin.page);
      setZoom(editingOrigin.zoom);
      setContinuousRestorePosition(editingOrigin.continuousPosition);
    }
    setEditingOrigin(null);
    const queued = await queueScoreDrafts(workspace);
    if (queued === 0) {
      setSyncOutcome("synced");
      return;
    }
    if (!navigator.onLine) {
      setSyncOutcome("local-saved");
      return;
    }
    if (cloudState !== "active") {
      setSyncOutcome("local-saved");
      return;
    }
    setSyncing(true);
    try {
      await syncAnnotations(workspace, { pull: false });
      setSyncOutcome("synced");
    } catch {
      setSyncOutcome("local-saved");
    } finally {
      setSyncing(false);
    }
  };

  const manualSync = async () => {
    if (!workspace) return;
    if (cloudState === "trashed") {
      setSyncOutcome("trash-preserved");
      return;
    }
    setSyncing(true);
    requestOutboxRecovery();
    try {
      await retryScoreSyncErrors(workspace);
      await queueScoreDrafts(workspace);
      await syncAnnotations(workspace, { pull: true });
      const remainingErrors = (await readScoreAnnotationState(workspace)).syncErrorCount;
      setSyncOutcome(remainingErrors > 0 ? "failed" : "synced");
    } catch {
      setSyncOutcome("failed");
    } finally {
      setSyncing(false);
    }
  };

  const resolveConflict = async (
    opId: string,
    strategy: "discard" | "reapply" | "keep-both",
  ) => {
    if (!workspace) return;
    if (strategy === "discard") {
      await discardAnnotationConflict(workspace, opId);
      setSyncOutcome("conflict-discarded");
      return;
    }
    await reapplyAnnotationConflict(workspace, opId, strategy === "keep-both");
    await queueScoreDrafts(workspace);
    if (!navigator.onLine) {
      setSyncOutcome("local-saved");
      return;
    }
    try {
      await syncAnnotations(workspace, { pull: false });
      setSyncOutcome("conflict-reapplied");
    } catch {
      setSyncOutcome("local-saved");
    }
  };

  if (!workspace) {
    return <main className="page-shell compact-page"><p role="status">正在打开本机工作区…</p><Link className="primary-link" to={`/choirs/${choirId}`}>返回云盘</Link></main>;
  }

  const displayChoices = <div className="reader-display-choices" aria-label="谱面显示方式">
    <Button isDisabled={annotationInteraction === "composing-text"} className="secondary-button" aria-pressed={reader.snapshot.mode === "pdf"} onPress={() => reader.selectMode("pdf")}>PDF 阅读</Button>
    <Button isDisabled={annotationInteraction === "composing-text"} className="secondary-button" aria-pressed={reader.snapshot.mode === "images"} onPress={() => reader.selectMode("images")}>图片兼容模式</Button>
    {reader.snapshot.modeMessage && <p role="status">{reader.snapshot.modeMessage}</p>}
  </div>;
  const loadError = reader.snapshot.error;
  if (loadError) {
    return (
      <main className="page-shell compact-page">
        <p className="eyebrow">乐谱阅读器</p>
        <h1>无法打开</h1>
        <p className="hero__copy" role="alert">
          {loadError}
        </p>
        <Link
          className="primary-link"
          to={`/choirs/${choirId}`}
          onClick={() => startLoadingJourney("exit-score", "warm")}
        >
          返回云盘
        </Link>
        <Button className="secondary-button" onPress={reader.retry}>重试加载</Button>
        {displayChoices}
        <Link to="/diagnostics">故障诊断</Link>
      </main>
    );
  }

  if (
    reader.snapshot.status !== "ready" ||
    !score ||
    !document ||
    documentScopeKey !== workspace.scopeKey
  ) {
    return (
      <main className="reader-loading" aria-label="正在加载乐谱">
        <div className="reader-loading__paper" aria-hidden="true" />
        <div className="reader-loading__label" role="status">
          <strong>{score?.fileName ?? "乐谱"}</strong>
          <span>{reader.snapshot.mode === "images" ? "正在准备图片兼容模式…" : "正在加载乐谱…"}</span>
          {displayChoices}
          <Link className="primary-link" to={`/choirs/${choirId}`}>返回云盘</Link>
          <Button className="secondary-button" onPress={reader.cancel}>取消加载</Button>
        </div>
      </main>
    );
  }

  const hasNewOfflineVersion =
    offline && offline.versionId !== score.currentVersion.id;
  const goToPage = (page: number) => {
    setZoom(1);
    const targetPage = clamp(page, 1, document.numPages);
    if (layout === "page" && !editing) requestPage(targetPage);
    else setCurrentPage(targetPage);
  };
  const selectLayout = (value: ReaderLayout) => {
    setZoom(1);
    setLayout(value);
    setMoreOpen(false);
  };
  const toggleChrome = () => {
    setMoreOpen(false);
    setChromeVisible((visible) => !visible);
  };
  const openReaderPanel = (panel: ReaderPanel) => {
    setMoreOpen(false);
    setReaderPanel(panel);
  };
  const selectEditingLayer = (layerId: string) => {
    if (!workspace) return;
    setActiveLayerId(layerId);
    writeStringPreference(`reader-edit-layer:${workspace.scopeKey}`, layerId);
  };
  const annotationPageProps: AnnotationPageProps = {
    workspace,
    layers,
    annotations,
    editing,
    tool,
    activeLayerId,
    onInteractionChange: setAnnotationInteraction,
  };
  const syncStatus = deriveReaderSyncStatus({
    outcome: syncOutcome,
    syncing,
    pendingCount,
    conflictCount: conflicts.length,
    syncErrorCount,
  });
  const readerTitle = displayReaderTitle(score.fileName);

  return (
    <DisplayRecovery.Provider value={{
      ready: page => { if (page === currentPage) { setVisibleDisplay(document); setFailedDisplay(null); } },
      failed: (page, reason) => {
        if (page !== currentPage) return;
        setFailedDisplay(document);
        if (!editing) reader.recoverDisplay(reason);
      },
    }}>
    <main className="reader-shell" data-chrome-visible={chromeVisible || undefined}>
      <h1 className="visually-hidden">{score.fileName}</h1>
      {cloudState === "trashed" ? (
        <aside className="reader-alert reader-alert--trash" role="alert">
          乐谱已移入回收站。本机离线副本和未同步批注仍保留，恢复后可继续同步。
        </aside>
      ) : null}
      {visibleDisplay !== document || failedDisplay === document ? <div className="reader-display-recovery" role="status">
        <span>{failedDisplay === document ? "页面显示失败，可重试本页或切换显示方式。" : "正在显示首屏…"}</span>
        <Link className="primary-link" to={`/choirs/${choirId}`}>返回云盘</Link>
        {displayChoices}
      </div> : null}
      {reader.snapshot.modeMessage ? <p className="reader-display-notice" role="status">{reader.snapshot.modeMessage}</p> : null}
      {chromeVisible ? (
      <header className="reader-chrome" aria-label="阅读器控制">
          <Link
            aria-label="返回云盘"
            aria-disabled={editing || undefined}
            className="reader-chrome__back reader-icon-button"
            to={`/choirs/${choirId}`}
            onClick={(event) => {
              if (editing) {
                event.preventDefault();
                return;
              }
              startLoadingJourney("exit-score", "warm");
            }}
          >
            <ArrowLeft aria-hidden="true" size={22} />
          </Link>
          <strong className="reader-chrome__title">{readerTitle}{editing ? <span className="reader-editing-hint">编辑中 · 点铅笔完成</span> : null}</strong>
          <div className="reader-chrome__actions-stack">
            <div className="reader-chrome__actions">
              <Button
                aria-describedby={editAvailability === "ready" ? undefined : "reader-edit-status"}
                aria-label="编辑"
                aria-description={editing ? "再次点按退出编辑，恢复阅读；编辑期间锁定当前页" : "进入当前页编辑"}
                className="reader-icon-button"
                data-state={editAvailability}
                aria-pressed={editing}
                isDisabled={
                  editAvailability === "preparing" ||
                  editAvailability === "read-only" ||
                  editAvailability === "trashed" ||
                  (editing && annotationInteraction === "composing-text")
                }
                onPress={() => editing ? void finishEditing() : requestEditing()}
              >
                <Pencil aria-hidden="true" size={21} />
              </Button>
              <Button
                aria-label="图层"
                aria-expanded={readerPanel === "layers"}
                className="reader-icon-button"
                isDisabled={editing}
                onPress={() => openReaderPanel("layers")}
              >
                <Layers aria-hidden="true" size={21} />
              </Button>
              <Button
                aria-label="更多"
                aria-expanded={moreOpen}
                className="reader-icon-button"
                isDisabled={editing}
                onPress={() => setMoreOpen((open) => !open)}
              >
                <Ellipsis aria-hidden="true" size={23} />
              </Button>
            </div>
            <Button
              aria-label="页面位置"
              aria-expanded={readerPanel === "pages"}
              className="reader-page-indicator"
              isDisabled={editing}
              onPress={() => openReaderPanel("pages")}
            >
              <span>{currentPage} / {document.numPages}</span>
              {editing ? <span className="reader-edit-finish-hint">点铅笔完成</span> : null}
            </Button>
            {editAvailability !== "ready" ? (
              <p
                className="reader-edit-status"
                data-state={editAvailability}
                id="reader-edit-status"
                role="status"
              >
                {editAvailability === "preparing"
                  ? "正在准备编辑…"
                  : editAvailability === "failed"
                    ? "编辑准备失败，点按铅笔重试"
                    : editAvailability === "read-only"
                      ? "此乐谱为只读状态"
                      : "乐谱在回收站中，恢复后可编辑"}
              </p>
            ) : null}
          </div>
          {moreOpen ? (
            <aside className="reader-more-menu" aria-label="更多阅读选项">
              <div className="segmented-control" aria-label="页面布局">
                <Button
                  aria-pressed={layout === "page"}
                  onPress={() => selectLayout("page")}
                >
                  <BookOpen aria-hidden="true" size={18} />
                  <span>翻页</span>
                </Button>
                <Button
                  aria-pressed={layout === "continuous"}
                  onPress={() => selectLayout("continuous")}
                >
                  <Rows3 aria-hidden="true" size={18} />
                  <span>连续滚动</span>
                </Button>
              </div>
              {displayChoices}
              <Button onPress={() => reader.setDefaultMode(reader.snapshot.mode)}>本机默认使用当前显示方式</Button>
              <Button onPress={reader.resetMode}>本谱跟随本机默认</Button>
              <Button onPress={() => reader.setDefaultMode(null)}>恢复本机默认 PDF 阅读</Button>
              <a href={`/api/choirs/${encodeURIComponent(choirId)}/scores/${encodeURIComponent(scoreId)}/versions/${encodeURIComponent(score.currentVersion.id)}/pdf`} download>下载原 PDF</a>
              <div className="reader-more-menu__zoom" aria-label="缩放控制">
                <Button aria-label="适合页面" onPress={() => setZoom(1)}>
                  <Maximize2 aria-hidden="true" size={18} />
                  <span>适合页面</span>
                </Button>
                <Button
                  aria-label="缩小"
                  onPress={() => setZoom((value) => Math.max(1, value - 0.25))}
                >
                  <Minus aria-hidden="true" size={18} />
                </Button>
                <span aria-live="polite">{Math.round(zoom * 100)}%</span>
                <Button
                  aria-label="放大"
                  onPress={() => setZoom((value) => Math.min(3, value + 0.25))}
                >
                  <Plus aria-hidden="true" size={18} />
                </Button>
              </div>
              <p className="reader-more-menu__status" role="status">
                {offlineScoreLabel(offline, score.currentVersion.id, offlineStatus?.invalid, reader.snapshot.mode)}
              </p>
              <Button
                isDisabled={downloading || cloudState === "trashed"}
                onPress={() => void downloadOffline()}
              >
                <Download aria-hidden="true" size={18} />
                {downloading ? "正在下载并校验…" : downloadMessage?.includes("未完成") ? "重试下载离线副本" : hasNewOfflineVersion ? "下载新版离线副本" : "下载离线副本"}
              </Button>
              <Button isDisabled={syncing || cloudState === "trashed"} onPress={() => void manualSync()}>
                <RefreshCw aria-hidden="true" size={18} />
                {syncing ? "同步中…" : "立即同步"}
              </Button>
              {downloadMessage || syncStatus.message ? (
                <p
                  className="reader-more-menu__status"
                  data-kind={downloadMessage ? "download" : syncStatus.kind}
                  role="status"
                >
                  {downloadMessage ?? syncStatus.message}
                </p>
              ) : null}
              <Link to="/diagnostics">故障诊断</Link>
            </aside>
          ) : null}
        </header>
      ) : null}

      {!editing && chromeVisible && readerPanel === "pages" ? (
        <PageNavigatorPanel
          document={document}
          currentPage={currentPage}
          onSelect={(page) => {
            goToPage(page);
            setReaderPanel(null);
          }}
        />
      ) : null}

      {editing && annotationInteraction !== "transforming-text" ? (
        <Suspense fallback={<p role="status">正在准备批注工具…</p>}>
          <ReaderEditingControls
            workspace={workspace}
            layers={layers}
            tool={tool}
            activeLayerId={activeLayerId}
            onToolChange={setTool}
            onLayerChange={selectEditingLayer}
          />
        </Suspense>
      ) : null}

      {!editing && showGestureHint ? (
        <p className="reader-gesture-hint" role="status">
          {layout === "page"
            ? "轻点页面中央显示控制，点按两侧或左右滑动翻页"
            : "轻点页面中央显示控制，上下滑动连续浏览"}
        </p>
      ) : null}

      {hasNewOfflineVersion ? (
        <aside className="reader-alert" role="status">
          云端已有新版本；完整下载并校验前，原离线副本会继续保留。
        </aside>
      ) : null}
      {readerPanel === "layers" ? (
        <ModalOverlay className="reader-panel-backdrop" isOpen isDismissable
          onOpenChange={(open) => { if (!open) setReaderPanel(null); }}>
          <Modal className="reader-panel reader-layers-dialog">
            <Dialog aria-label="图层" className="reader-layers-content">
              <header className="reader-panel__header">
                <strong>图层</strong>
                <Button aria-label="关闭页面与图层" onPress={() => setReaderPanel(null)}>
                  关闭
                </Button>
              </header>
              <Suspense fallback={<p role="status">正在准备图层…</p>}>
                <ReaderLayerPanel
                  key={workspace.scopeKey}
                  workspace={workspace}
                  layers={layers}
                  signedIn={Boolean(session.data?.user.id)}
                />
              </Suspense>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}

      {conflicts.length > 0 ? (
        <aside className="annotation-conflicts" aria-label="本地批注冲突">
          <strong>仍有 {conflicts.length} 项本机冲突待处理</strong>
          <p>同一批注的云端版本已经变化；以下是保留在这台设备上的版本。</p>
          {conflicts.map((conflict) => {
            const detail = describeAnnotationConflict(
              conflict,
              layers.find((layer) => layer.id === conflict.layerId)?.name ?? "未知图层",
            );
            return (
              <div className="annotation-conflict-item" key={conflict.opId}>
                <span>
                  第 {detail.pageNumber} 页 · {detail.layerName} · {detail.summary}
                </span>
                <Button onPress={() => goToPage(detail.pageNumber)}>
                  前往第 {detail.pageNumber} 页
                </Button>
                <Button
                  onPress={() => void resolveConflict(conflict.opId, "discard")}
                >
                  放弃本机版本
                </Button>
                <Button
                  onPress={() => void resolveConflict(conflict.opId, "reapply")}
                >
                  基于云端重新应用
                </Button>
                <Button
                  onPress={() => void resolveConflict(conflict.opId, "keep-both")}
                >
                  两份都保留
                </Button>
              </div>
            );
          })}
        </aside>
      ) : null}
      {syncErrorCount > 0 ? (
        <aside className="annotation-conflicts" aria-label="批注同步异常">
          <strong>{syncErrorCount} 项批注同步异常</strong>
          <div>
            <span>本机版本仍然保留。若共享层编辑权已撤销，请在恢复权限后重试；其它有权限的批注会继续同步。</span>
            <Button isDisabled={syncing} onPress={() => void manualSync()}>
              重试同步
            </Button>
          </div>
        </aside>
      ) : null}
      <div className="reader-stage">
        {layout === "page" ? (
          <PageLayout
            document={document}
            currentPage={currentPage}
            zoom={zoom}
            onZoomChange={setZoom}
            onToggleChrome={toggleChrome}
            annotationProps={annotationPageProps}
            pager={pager}
          />
        ) : (
          <ContinuousLayout
            document={document}
            currentPage={currentPage}
            zoom={zoom}
            onZoomChange={setZoom}
            onPageChange={setCurrentPage}
            onToggleChrome={toggleChrome}
            annotationProps={annotationPageProps}
            restorePosition={continuousRestorePosition}
            onPositionChange={(position) => {
              continuousPosition.current = position;
            }}
            onRestoreComplete={() => setContinuousRestorePosition(null)}
          />
        )}
      </div>
    </main>
    </DisplayRecovery.Provider>
  );
}

function readBooleanPreference(key: string) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function displayReaderTitle(fileName: string) {
  const title = fileName.replace(/\.pdf$/i, "");
  return title || fileName;
}

function readStringPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStringPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Editing remains available when persistent preferences are unavailable.
  }
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function compareLayers(left: AnnotationLayerSummary, right: AnnotationLayerSummary) {
  if (left.kind !== right.kind) return left.kind === "shared" ? -1 : 1;
  const leftDefault = left.defaultSlot
    ? defaultSharedLayerSlots.indexOf(left.defaultSlot)
    : Number.POSITIVE_INFINITY;
  const rightDefault = right.defaultSlot
    ? defaultSharedLayerSlots.indexOf(right.defaultSlot)
    : Number.POSITIVE_INFINITY;
  if (leftDefault !== rightDefault) return leftDefault - rightDefault;
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-CN");
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}
