import { BackButton } from "../navigation/back-button";
import { ReaderLoading } from "../navigation/reader-loading";
import { useAppNavigation, useExitLayer } from "../navigation/navigation-context";
import { DisplayRecovery } from "../reader/display-recovery";
import type { ScoreDocument } from "../reader/image-document";
import "../reader/reader-ux.css";
import { useReaderSession } from "../reader/use-reader-session";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft, Download, Ellipsis, Layers, Maximize2, Minus, Pencil, Plus, BookOpen,
  RefreshCw, Rows3, Check,
} from "lucide-react";
import {
  useEffect,
  lazy,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
} from "react";
import {
  Button,  Modal, ModalOverlay, Popover,
} from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { Link, useParams } from "react-router-dom";

import { sharedLayerDisplayName } from "../../shared/annotations";
import type { AnnotationLayerSummary } from "../../shared/annotations";
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
import { getAnnotationSyncActivity, subscribeAnnotationSync, syncAnnotations } from "../annotations/sync";
import { useAnnotationEditor } from "../annotations/use-annotation-editor";
import type { AnnotationEditor } from "../annotations/annotation-editor";
import { useApplicationIdentity } from "../auth/application-identity";
import { IdentityNotice } from "../auth/local-entry";
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
import { offlineScoreLabel, offlineDownloadFailure, useOfflineScore } from "../offline/use-offline-score";
import { driveCacheOwnerKey } from "../score-library/drive-library-cache";
import { recordScoreOpened } from "../score-library/library-view-state";
import {
  type AnnotationPageProps,
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

import type { DiagnosticReader } from "../../shared/diagnostic-report";
import { DiagnosticReportDialog, DiagnosticReportModal } from "../diagnostics/diagnostic-report-dialog";

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
  const identity = useApplicationIdentity();
  return <ReaderPageContent key={`${identity.localUserId ?? "guest"}:${choirId}:${scoreId}`} />;
}

function ReaderPageContent() {
  const { choirId = "", scoreId = "" } = useParams();
  const identity = useApplicationIdentity();
  const [resolvedWorkspace, setResolvedWorkspace] =
    useState<LocalWorkspace | null>(null);
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const workspaceIsActive = useLiveQuery(
    () => resolvedWorkspace
      ? isLocalWorkspaceActive(resolvedWorkspace)
      : false,
    [resolvedWorkspace?.scopeKey],
    false,
  );
  const navigation = useAppNavigation();
  const [zoom, setZoom] = useState(1);
  const [editingEditor, setEditingEditor] = useState<AnnotationEditor | null>(null);
  const [annotationInteraction, setAnnotationInteraction] =
    useState<AnnotationOverlayInteraction>("idle");
  const [tool, setTool] = useState<AnnotationTool>("text");
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [syncOutcome, setSyncOutcome] = useState<ReaderSyncOutcome>("none");
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const syncActivity = useSyncExternalStore(subscribeAnnotationSync,
    () => getAnnotationSyncActivity(resolvedWorkspace?.scopeKey ?? ""));
  useEffect(() => subscribeAnnotationSync(() => {
    if (getAnnotationSyncActivity(resolvedWorkspace?.scopeKey ?? "") === "running") setSyncOutcome("none");
  }), [resolvedWorkspace?.scopeKey]);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [readerPanel, setReaderPanel] = useState<ReaderPanel | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const [showGestureHint, setShowGestureHint] = useState(
    () => !readBooleanPreference("reader-gesture-hint-seen"),
  );
  useEffect(() => {
    ensureLoadingJourney("open-score", "direct");
  }, []);
  const waitingForIdentity = identity.restoring || (!identity.localUserId && identity.onlineState === "checking");
  useEffect(() => {
    if (workspaceError) return;
    let active = true;
    const controller = new AbortController();
    const fail = (message: string) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      setWorkspaceError(message);
    };
    const timer = setTimeout(() => fail("打开本机工作区用时较长，可以重试或返回云盘。"), 45_000);
    if (waitingForIdentity) return () => { active = false; clearTimeout(timer); };
    void resolveLocalWorkspace({
      authenticatedUserId: identity.localUserId,
      signal: controller.signal,
      choirId,
      scoreId,
    }).then(async (resolved) => {
      if (!active) return;
      const workspace = await captureLocalWorkspaceSession(resolved);
      try {
        await cleanupUncreatedDeleteConflicts(workspace);
      } catch {
        // Historical cleanup must never prevent the local workspace from opening.
      }
      if (active) {
        clearTimeout(timer);
        setResolvedWorkspace(workspace);
      }
    }).catch(() => fail("本机工作区暂时无法打开，请重试；已保存的内容仍然保留。"));
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [choirId, scoreId, identity.localUserId, waitingForIdentity, workspaceAttempt, workspaceError]);

  const workspace =
    resolvedWorkspace &&
    (!identity.localUserId || resolvedWorkspace.ownerKey === `user:${identity.localUserId}`) &&
    workspaceIsActive &&
    resolvedWorkspace.choirId === choirId &&
    resolvedWorkspace.scoreId === scoreId
      ? resolvedWorkspace
      : null;
  const { editor, persistence } = useAnnotationEditor(workspace);
  const editing = editor !== null && editor === editingEditor;
  const [visibleDisplay, setVisibleDisplay] = useState<ScoreDocument | null>(null);
  const [failedDisplay, setFailedDisplay] = useState<ScoreDocument | null>(null);
  const reader = useReaderSession(workspace, identity.authenticatedUserId);
  const { score, document, offline: loadedOffline, cloudState, downloading, downloadMessage } = reader.snapshot;
  const documentScopeKey = document ? workspace?.scopeKey ?? null : null;
  const offlineStatus = useOfflineScore(workspace);
  const offline = offlineStatus?.scopeKey === workspace?.scopeKey ? offlineStatus?.record ?? null : loadedOffline;
  const downloadOffline = reader.download;
  useEffect(() => {
    if (document && workspace && documentScopeKey === workspace.scopeKey) {
      recordScoreOpened(driveCacheOwnerKey(workspace.ownerKey.startsWith("user:") ? workspace.ownerKey.slice(5) : null, choirId), choirId, scoreId);
    }
  }, [document, documentScopeKey, workspace, choirId, scoreId, identity.authenticatedUserId]);
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
      identity: identity.localUserId ?? "guest",
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
        readerPanel !== null || moreOpen || diagnosticOpen ||
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
  }, [editing, layout, moreOpen, diagnosticOpen, readerPanel, requestPage]);

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
    if (!editableLayer || !editor?.begin()) return;
    setChromeVisible(true);
    setMoreOpen(false);
    setReaderPanel(null);
    setActiveLayerId(editableLayer.id);
    writeStringPreference(preferenceKey, editableLayer.id);
    setTool("text");
    setEditingEditor(editor);

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
    if (!workspace || !editor || !await editor.prepareFinish()) return false;
    try { await queueScoreDrafts(workspace); }
    catch { setSyncOutcome("failed"); return false; }
    if (!editor.finish()) return false;
    setEditingEditor(null);
    setSyncOutcome("local-saved");
    requestOutboxRecovery();
    return true;
  };
  useExitLayer(editing, "editing", finishEditing);
  useExitLayer(readerPanel === "pages", "overlay", () => { setReaderPanel(null); return true; });

  const manualSync = async () => {
    if (!workspace) return;
    if (cloudState === "trashed") {
      setSyncOutcome("trash-preserved");
      return;
    }
    if (!identity.authenticatedUserId) {
      // A manual retry must also recover a missed connectivity notification.
      await identity.session.refetch();
      setSyncOutcome("local-saved");
      return; // The identity observer resumes queued work after confirmation.
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
    if (!navigator.onLine || !identity.authenticatedUserId) {
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

  const diagnosticReader: DiagnosticReader = {
    displayMode: reader.snapshot.mode,
    interactionMode: editing ? "editing" : "reading",
    pendingCount: activeAnnotations ? Math.min(9999, pendingCount) : null,
    conflictCount: activeAnnotations ? Math.min(9999, conflicts.length) : null,
  };
  const diagnosticDialog = <DiagnosticReportDialog reader={diagnosticReader} />;

  const loadingScreen = <ReaderLoading choirId={choirId} fileName={score?.fileName} />;

  if (!workspace) {
    if (!workspaceError) return loadingScreen;
    return <main className="page-shell compact-page">
      <h1>无法打开</h1>
      <p role="alert">{workspaceError}</p>
      <BackButton className="primary-link" to={`/choirs/${choirId}`}>返回云盘</BackButton>
      <Button className="secondary-button" onPress={() => { setWorkspaceError(null); setWorkspaceAttempt(value => value + 1); }}>重试打开工作区</Button>
      <details><summary>更多帮助</summary>{diagnosticDialog}</details>
    </main>;
  }

  const displayChoices = <Button className="secondary-button" onPress={() => navigation.afterEditing(reader.retry)}>重试 PDF 阅读</Button>;
  const loadError = reader.snapshot.error;
  if (loadError) {
    return (
      <main className="page-shell compact-page">
        <p className="eyebrow">乐谱阅读器</p>
        <h1>无法打开</h1>
        <p className="hero__copy" role="alert">
          {loadError}
        </p>
        <BackButton className="primary-link" to={`/choirs/${choirId}`}>返回云盘</BackButton>
        <Button className="secondary-button" onPress={() => navigation.afterEditing(reader.retry)}>重试加载</Button>
        <details><summary>更多帮助</summary>{displayChoices}{diagnosticDialog}</details>
      </main>
    );
  }

  if (
    reader.snapshot.status !== "ready" ||
    !score ||
    !document ||
    documentScopeKey !== workspace.scopeKey
  ) {
    return loadingScreen;
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
    layers,
    annotations,
    editing,
    tool,
    activeLayerId,
    onInteractionChange: setAnnotationInteraction,
    editor,
  };
  const syncStatus = deriveReaderSyncStatus({
    outcome: cloudState === "trashed" ? "trash-preserved" : syncActivity === "failed" && online ? "failed" : syncOutcome,
    syncing: syncing || syncActivity === "running",
    loaded: activeAnnotations !== null,
    draftCount: annotations.filter(annotation => annotation.state === "draft").length,
    acceptedCount: annotations.filter(annotation => annotation.state === "synced" && annotation.version > 0).length,
    permissionErrorCount: annotations.filter(annotation => annotation.syncErrorCode === "permission_denied" ||
      (annotation.state !== "synced" && !layers.some(layer => layer.id === annotation.layerId && layer.canEdit))).length,
    online,
    pendingCount,
    conflictCount: conflicts.length,
    syncErrorCount,
  });
  const readerTitle = displayReaderTitle(score.fileName);

  return (
    <DisplayRecovery.Provider value={{
      ready: page => { if (page === currentPage) { setVisibleDisplay(document); setFailedDisplay(null); reader.confirmDisplay(document); } },
      failed: (page, reason) => {
        if (page !== currentPage) return;
        setFailedDisplay(document);
        if (!editing) reader.recoverDisplay(reason);
      },
    }}>
    <main className="reader-shell" data-chrome-visible={chromeVisible || undefined}>
      <DiagnosticReportModal
        reader={diagnosticReader}
        isOpen={diagnosticOpen}
        onOpenChange={open => {
          setDiagnosticOpen(open);
          // Restore focus after the modal releases its focus trap and inert background.
          if (!open) requestAnimationFrame(() => moreTrigger.current?.focus());
        }}
      />
      <h1 className="visually-hidden">{score.fileName}</h1>
      {cloudState === "trashed" ? (
        <aside className="reader-alert reader-alert--trash" role="alert">
          乐谱已移入回收站。本机离线副本和未同步批注仍保留，恢复后可继续同步。
        </aside>
      ) : null}
      {visibleDisplay !== document && failedDisplay !== document ? <ReaderLoading choirId={choirId} fileName={score.fileName} /> : null}
      {failedDisplay === document ? <div className="reader-display-recovery" role="alert">
        <span>页面显示失败，本机草稿仍保留。</span>{displayChoices}{diagnosticDialog}
      </div> : null}
      {reader.snapshot.modeMessage ? <p className="reader-display-notice" role="status">{reader.snapshot.modeMessage}{reader.snapshot.mode === "images" && <Button className="text-button" onPress={() => navigation.afterEditing(reader.retry)}>重试 PDF 阅读</Button>}</p> : null}
      {chromeVisible ? (
      <header className="reader-chrome" aria-label="阅读器控制">
          <Button aria-label="返回云盘" className="reader-chrome__back reader-icon-button" onPress={() => { startLoadingJourney("exit-score", "warm"); navigation.back(`/choirs/${choirId}`); }}>
            <ArrowLeft aria-hidden="true" size={21} />
          </Button>
          <strong className="reader-chrome__title">{readerTitle}</strong>
          <div className="reader-chrome__actions-stack">
            <div className="reader-chrome__actions">
              <Button
                aria-describedby={editAvailability === "ready" ? undefined : "reader-edit-status"}
                aria-label={editing ? "完成编辑" : "编辑"}
                aria-description={editing ? "完成后恢复阅读和翻页" : "进入当前页编辑"}
                className="reader-icon-button"
                data-state={editAvailability}
                aria-pressed={editing}
                isDisabled={
                  editAvailability === "preparing" ||
                  editAvailability === "read-only" ||
                  editAvailability === "trashed"
                }
                onPress={() => editing ? navigation.afterEditing(() => { /* Completion is performed by the editing exit layer. */ }) : requestEditing()}
              >
                {editing ? <Check aria-hidden="true" size={21} /> : <Pencil aria-hidden="true" size={21} />}
              </Button>
              <Button
                aria-label="看哪些批注"
                aria-expanded={readerPanel === "layers"}
                className="reader-icon-button"
                onPress={() => { if (editing) navigation.afterEditing(() => openReaderPanel("layers")); else openReaderPanel("layers"); }}
              >
                <Layers aria-hidden="true" size={21} />
              </Button>
              <Button
                ref={moreTrigger}
                aria-label="更多"
                aria-expanded={moreOpen}
                className="reader-icon-button"
                onPress={() => setMoreOpen((open) => !open)}
              >
                <Ellipsis aria-hidden="true" size={21} />
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
            </Button>
            {editing && annotationInteraction !== "composing-text" && <span className="reader-save-feedback" role="status">
              {persistence === "saving" ? "正在保存到本机…" : persistence === "failed" ? "本机保存失败" : annotations.some(annotation => annotation.state === "draft") ? "已保存在本机" : "正在编辑当前页"}
            </span>}
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
            <Popover triggerRef={moreTrigger} isOpen={moreOpen} onOpenChange={setMoreOpen} isNonModal placement="bottom end" className="reader-more-popover">
            <Dialog className="reader-more-menu" aria-label="更多阅读选项">
              <IdentityNotice identity={identity} />
              <header className="reader-menu-heading"><strong>阅读选项</strong><Button aria-label="关闭更多阅读选项" onPress={() => setMoreOpen(false)}>关闭</Button></header>
              {!editing && <>
              <section aria-label="页面布局与缩放"><h2>页面布局与缩放</h2>
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
              </section>
              <section aria-label="原文件"><h2>原文件</h2>
              <a href={`/api/choirs/${encodeURIComponent(choirId)}/scores/${encodeURIComponent(scoreId)}/versions/${encodeURIComponent(score.currentVersion.id)}/pdf`} download>下载原 PDF</a>
              </section>
              <section aria-label="本机离线副本"><h2>本机离线副本 · {reader.snapshot.mode === "pdf" ? "PDF" : "图片"}</h2>
              <p className="reader-more-menu__status" role="status">
                {downloading ? "正在下载并校验…" : downloadMessage?.includes("未完成") ? (!offlineStatus ? "离线下载未完成，尚未确认本机副本，请重试校验。" : offlineDownloadFailure(offline, score.currentVersion.id, offlineStatus.invalid, reader.snapshot.mode)) : !offlineStatus ? "正在校验本机副本…" : offlineScoreLabel(offline, score.currentVersion.id, offlineStatus.invalid, reader.snapshot.mode)}
              </p>
              <Button
                isDisabled={downloading || cloudState === "trashed"}
                onPress={() => void downloadOffline()}
              >
                <Download aria-hidden="true" size={18} />
                {downloading ? "正在下载并校验…" : downloadMessage?.includes("未完成") ? "重试下载离线副本" : hasNewOfflineVersion ? "下载新版离线副本" : "下载离线副本"}
              </Button>
              {downloadMessage && !downloadMessage.includes("未完成") && <p className="reader-more-menu__status" role="status">{downloadMessage}</p>}
              </section>
              <section aria-label="批注保存与同步"><h2>批注保存与同步</h2>
                <p className="reader-more-menu__status" data-kind={syncStatus.kind} role="status">{syncStatus.message}</p>
                <Button className="reader-sync-action" isDisabled={syncing || syncActivity === "running" || cloudState === "trashed"} onPress={() => void manualSync()}>
                  <RefreshCw aria-hidden="true" size={18} />
                  {syncing || syncActivity === "running" ? "同步中…" : syncStatus.kind === "failed" ? "重试同步" : "立即同步"}
                </Button>
              </section>
              </>}
              <section aria-label="阅读帮助"><h2>帮助</h2>
                <p className="reader-more-menu__status">轻点中央显示工具；点按两侧或左右滑动翻页。编辑时锁定当前页，点勾号完成后继续翻页。批注同步与离线副本分别准备。</p>
                <Button onPress={() => { setMoreOpen(false); setDiagnosticOpen(true); }}>故障诊断</Button>
              </section>
            </Dialog>
            </Popover>
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

      {editing && editor && annotationInteraction === "idle" ? (
        <Suspense fallback={<p role="status">正在准备批注工具…</p>}>
          <ReaderEditingControls
            isDisabled={persistence !== "idle"}
            editor={editor}
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
            <Dialog aria-label="看哪些批注" className="reader-layers-content">
              <header className="reader-panel__header">
                <strong>看哪些批注</strong>
                <Button aria-label="关闭批注显示" onPress={() => setReaderPanel(null)}>
                  关闭
                </Button>
              </header>
              <Suspense fallback={<p role="status">正在准备图层…</p>}>
                <ReaderLayerPanel
                  key={workspace.scopeKey}
                  workspace={workspace}
                  layers={layers}
                  signedIn={Boolean(identity.authenticatedUserId)}
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
            const layer = layers.find(layer => layer.id === conflict.layerId);
            const layerName = layer ? (layer.kind === "personal" && layer.canEdit ? "我的笔记" : sharedLayerDisplayName(layer.sharedSlot, layer.name)) : "未知图层";
            const detail = describeAnnotationConflict(
              conflict,
              layerName,
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
      {syncStatus.kind === "failed" || syncStatus.kind === "risk" ? (
        <aside className="annotation-conflicts" aria-label="批注同步异常">
          <strong>{syncStatus.message}</strong>
          <div>
            <Link className="text-button" aria-disabled={editing || undefined} to="/diagnostics">查看原因</Link>
            <Button isDisabled={syncing} onPress={() => void manualSync()}>
              重试同步
            </Button>
            {diagnosticDialog}
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
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-CN");
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}
