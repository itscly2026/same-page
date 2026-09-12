import { subscribeReaderSync } from "../reader/sync-reader";
import { LocalPdfDownload } from "../reader/local-pdf-download";
import { useReaderFullscreen } from "../reader/use-reader-fullscreen";
import { clearGuestNotes, isLocalExperience } from "../annotations/guest-notes";
import { useReadingPreferenceProjection } from "../reader/reading-preference-intents";
import { loginHref } from "../auth/login-return";
import { useLocation, useNavigationType } from "react-router-dom";
import { useReturnState } from "../navigation/navigation-context";
import { useReaderAnnotationActions } from "../reader/use-reader-annotation-actions";
import { useToolColor } from "../reader/use-tool-color";
import { offlinePreparationDescription } from "../offline/offline-score-status";
import { ExportDialog } from "../reader/export-dialog";
import { scoreDisplayName } from "../../shared/score-display-name";
import { BackButton } from "../navigation/back-button";
import { ReaderLoading } from "../navigation/reader-loading";
import { useAppNavigation, useExitLayer } from "../navigation/navigation-context";
import { ReaderPresentationContext, useReaderPresentation } from "../reader/use-reader-presentation";
import "../reader/reader-ux.css";
import { useReaderSession } from "../reader/use-reader-session";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft, FileUp, HardDrive, Ellipsis, Layers, Maximize2, Minus, Pencil, Plus, BookOpen,
  RefreshCw, Rows3, Check, X, Maximize, ChevronDown,
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
  Button, Tooltip, TooltipTrigger, Modal, ModalOverlay, Popover,
} from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { Link, useParams } from "react-router-dom";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import type {
  AnnotationOverlayInteraction,
} from "../annotations/annotation-overlay";
import {
  cleanupUncreatedDeleteConflicts,
  readScoreAnnotationState,
} from "../annotations/annotation-state";
import { getAnnotationSyncActivity, subscribeAnnotationSync } from "../annotations/sync";
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
import { useOfflineScore } from "../offline/use-offline-score";
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

type ReaderPanel = "layers";

import { useLastTool } from "../reader/use-last-tool";
import { useToolStyle } from "../reader/use-tool-style";

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
  const location = useLocation();
  const identity = useApplicationIdentity();
  return <ReaderPageContent key={`${identity.localUserId ?? "guest"}:${choirId}:${scoreId}:${location.search}`} />;
}

function ReaderPageContent() {
  const fullscreen = useReaderFullscreen();
  const location = useLocation();
  const experience = new URLSearchParams(location.search).get("experience") === "1";
  const navigationType = useNavigationType();
  const returnedPanel = navigationType !== "POP" && location.state?.readerReturnPanel === "layers";
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
  const [fitRequest, setFitRequest] = useState(0);
  const [zoom, setZoom] = useReturnState("zoom", 1);
  const [editingEditor, setEditingEditor] = useState<AnnotationEditor | null>(null);
  const [annotationInteraction, setAnnotationInteraction] =
    useState<AnnotationOverlayInteraction>("idle");
  const { tool, setTool } = useLastTool(resolvedWorkspace?.ownerKey ?? `user:${identity.localUserId ?? "guest"}`);
  const { style: toolStyle, setStyle: setToolStyle } = useToolStyle(resolvedWorkspace?.ownerKey ?? `user:${identity.localUserId ?? "guest"}`, tool);
  const { color: toolColor, setColor: setToolColor } = useToolColor(resolvedWorkspace?.ownerKey ?? `user:${identity.localUserId ?? "guest"}`, tool);
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
  const [chromeVisible, setChromeVisible] = useReturnState("chrome", returnedPanel);
  const [readerPanel, setReaderPanel] = useReturnState<ReaderPanel | null>("panel", returnedPanel ? "layers" : null);
  const [cloudCheck, setCloudCheck] = useState<{ scope: string; at: number } | null>(null);
  useEffect(() => {
    if (!resolvedWorkspace) return;
    return subscribeReaderSync(resolvedWorkspace, result => {
      if (result.state === "active") setCloudCheck({ scope: resolvedWorkspace.scopeKey, at: Date.now() });
    });
  }, [resolvedWorkspace]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const layersTrigger = useRef<HTMLButtonElement>(null);
  const previousPanel = useRef(readerPanel);
  useEffect(() => {
    const closedLayers = previousPanel.current === "layers" && readerPanel === null;
    previousPanel.current = readerPanel;
    if (!closedLayers) return;
    const frame = requestAnimationFrame(() => layersTrigger.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [readerPanel]);
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
      experience,
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
  }, [choirId, scoreId, identity.localUserId, waitingForIdentity, workspaceAttempt, workspaceError, experience]);

  const workspace =
    resolvedWorkspace &&
    (!identity.localUserId || resolvedWorkspace.ownerKey === `${experience ? "experience:" : ""}user:${identity.localUserId}`) &&
    workspaceIsActive &&
    resolvedWorkspace.choirId === choirId &&
    resolvedWorkspace.scoreId === scoreId
      ? resolvedWorkspace
      : null;
  const { editor, persistence } = useAnnotationEditor(workspace);
  const editing = editor !== null && editor === editingEditor;
  const [exportOpen, setExportOpen] = useState(false);
  const reader = useReaderSession(workspace, identity.authenticatedUserId, identity.authenticatedSessionId);
  const { score, document, offline: loadedOffline, cloudState, downloading, downloadMessage, preparation } = reader.snapshot;
  const documentScopeKey = document ? workspace?.scopeKey ?? null : null;
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const offlineStatus = useOfflineScore(workspace, inspectionAttempt);
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
  const layers = useReadingPreferenceProjection(workspace, [...activeAnnotations?.layers ?? []]).sort(compareLayers);
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
  const presentation = useReaderPresentation(reader.presentation, document, currentPage, editing);
  const pager = usePagedReader({
    currentPage,
    pageCount: document?.numPages ?? 1,
    documentKey: `${documentScopeKey ?? "none"}:${score?.currentVersion.id ?? "none"}`,
    enabled: layout === "page" && document !== null,
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
  }, [editing, layout, moreOpen, diagnosticOpen, readerPanel, requestPage, setZoom]);

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

  const annotationActions = useReaderAnnotationActions(workspace, identity.authenticatedUserId, identity.authenticatedSessionId, online, cloudState === "trashed", identity.session.refetch);
  const finishEditing = async () => {
    if (!editor) return false;
    const result = await editor.finish();
    if (result !== "local-saved") { if (result) setSyncOutcome(result); return false; }
    setEditingEditor(null);
    setSyncOutcome(result);
    return true;
  };
  useExitLayer(editing, "editing", finishEditing);

  const manualSync = async () => {
    if (!annotationActions || syncing) return;
    setSyncing(true);
    const result = await annotationActions.retry();
    if (result) setSyncOutcome(result);
    setSyncing(false);
  };

  const resolveConflict = async (opId: string, strategy: "discard" | "reapply" | "keep-both") => {
    if (!annotationActions) return;
    const result = await annotationActions.resolveConflict(opId, strategy);
    if (result) setSyncOutcome(result);
  };

  const diagnosticReader: DiagnosticReader = {
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

  const originalPdfDownload = online && cloudState === "active" && score ? <a className="secondary-button"
    href={`/api/choirs/${encodeURIComponent(choirId)}/scores/${encodeURIComponent(scoreId)}/versions/${encodeURIComponent(score.currentVersion.id)}/pdf`}
    download={score.fileName}>下载原 PDF</a> : offline ? <LocalPdfDownload workspace={workspace} record={offline} /> : null;
  const displayChoices = <><Button className="secondary-button" onPress={() => navigation.afterEditing(reader.retry)}>重试 PDF 阅读</Button>{originalPdfDownload}</>;
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
        {originalPdfDownload}
        <details><summary>更多帮助</summary>{diagnosticDialog}</details>
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
    toolColor,
    toolStyle,
    onTextStyleChange: value => setToolStyle({ ...toolStyle, ...value }),
    activeLayerId,
    onInteractionChange: setAnnotationInteraction,
    editor,
  };
  const guestExperience = workspace ? isLocalExperience(workspace) : false;
  const syncStatus = deriveReaderSyncStatus({
    localOnly: guestExperience,
    outcome: guestExperience ? syncOutcome : cloudState === "trashed" ? "trash-preserved" : syncActivity === "failed" && online ? "failed" : syncOutcome,
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
  const readerTitle = scoreDisplayName(score.fileName);

  return (
    <ReaderPresentationContext.Provider value={presentation.context}>
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
      <h1 className="visually-hidden">{scoreDisplayName(score.fileName)}</h1>
      {editing && annotationInteraction !== "composing-text" && persistence === "failed" && <aside className="reader-alert" role="alert">本机保存失败</aside>}
      {cloudState === "trashed" ? (
        <aside className="reader-alert reader-alert--trash" role="alert">
          乐谱已移入回收站。本机离线副本和未同步笔记仍保留，恢复后可继续同步。
        </aside>
      ) : null}
      {presentation.status === "pending" ? <ReaderLoading choirId={choirId} fileName={score.fileName} /> : null}
      {presentation.status === "failed" ? <div className="reader-display-recovery" role="alert">
        <span>页面显示失败，本机草稿仍保留。</span>{displayChoices}{diagnosticDialog}
      </div> : null}
      {reader.snapshot.displayMessage ? <p className="reader-display-notice" role="status">{reader.snapshot.displayMessage}</p> : null}
      {chromeVisible ? (
      <header className="reader-chrome" aria-label="阅读器控制">
          {!editing && <div className="reader-chrome__leading"><Button aria-label="返回云盘" className="reader-chrome__back reader-icon-button" onPress={() => { startLoadingJourney("exit-score", "warm"); navigation.back(`/choirs/${choirId}`); }}>
            <ArrowLeft aria-hidden="true" size={21} />
          </Button>
          <TooltipTrigger><Button aria-label="导出 PDF" className="reader-icon-button reader-chrome__export" onPress={() => setExportOpen(true)}><FileUp aria-hidden="true" size={21} /></Button><Tooltip className="offline-score-tooltip">导出 PDF</Tooltip></TooltipTrigger></div>}
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
              {!editing && <><Button
                ref={layersTrigger}
                aria-label="笔记图层"
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
              </Button></>}
            </div>
            {editAvailability !== "ready" && !(editAvailability === "preparing" && readerPanel !== null) ? (
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
                      ? <>此乐谱为只读状态{!identity.localUserId && <Link to={loginHref(`/choirs/${choirId}/scores/${scoreId}`)}>登录后写自己的笔记</Link>}</>
                      : "乐谱在回收站中，恢复后可编辑"}
              </p>
            ) : null}
          </div>
          {!editing && moreOpen ? (
            <Popover triggerRef={moreTrigger} isOpen={moreOpen} onOpenChange={setMoreOpen} isNonModal placement="bottom end" className="reader-more-popover">
            <Dialog className="reader-more-menu" aria-label="更多阅读选项">
              <header className="reader-menu-heading"><strong>阅读选项</strong><Button className="icon-button" aria-label="关闭更多阅读选项" onPress={() => setMoreOpen(false)}><X size={20} aria-hidden="true" /></Button></header>
              <IdentityNotice identity={identity} />
              {guestExperience && <section aria-label="本机体验笔记"><h2>本机体验笔记</h2><p>仅保存在此浏览器，不上传、不修改公开内容。</p>
                <Button onPress={() => { if (workspace) void clearGuestNotes(workspace).then(() => setSyncOutcome("local-saved")).catch(() => setSyncOutcome("failed")); }}>清除本谱体验笔记</Button>
              </section>}
              {!editing && <>
              <section aria-label="页面布局与缩放" className="reader-options-display"><div className="reader-option-heading"><h2>阅读方式</h2>
              {fullscreen.supported && <Button className="reader-option-action" onPress={() => void fullscreen.toggle()}><Maximize size={15} aria-hidden="true" />{fullscreen.active ? "退出全屏" : "全屏阅读"}</Button>}</div>
              {fullscreen.error && <p role="status">{fullscreen.error}</p>}
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
                <Button aria-label="适合页面" onPress={() => { setZoom(1); setFitRequest(value => value + 1); }}>
                  <Maximize2 aria-hidden="true" size={18} />
                  <span>适合页面</span>
                </Button>
                <Button
                  aria-label="缩小"
                  onPress={() => setZoom((value) => Math.max(layout === "continuous" ? 0.1 : 1, value - 0.25))}
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
              <section aria-label="本机离线副本"><div className="reader-option-heading reader-option-heading--status"><h2><HardDrive size={17} aria-hidden="true" />离线使用</h2>
              <p className="reader-more-menu__status" role="status">
                {offlinePreparationDescription(preparation, offlineStatus ? { record: offline, invalid: offlineStatus.invalid, readFailed: offlineStatus.readFailed } : null, score.currentVersion.id)}
              </p></div>
              {offlineStatus?.readFailed && <Button className="secondary-button" onPress={() => setInspectionAttempt(value => value + 1)}>重试校验</Button>}
              {!offlineStatus?.readFailed && (!offlineStatus || !offline || offlineStatus.invalid || hasNewOfflineVersion || preparation.phase === "failed" || downloading) && (
              <Button
                isDisabled={(preparation.phase === "preparing" && preparation.intent === "explicit") || cloudState === "trashed"}
                onPress={() => void downloadOffline()}
              >
                <HardDrive aria-hidden="true" size={18} />
                {downloading ? preparation.phase === "preparing" && preparation.intent === "automatic" ? "继续保存（切换页面不中断）" : "正在准备并校验…" : preparation.phase === "failed" ? "重试保存离线副本" : hasNewOfflineVersion ? "更新离线副本" : "保存供离线使用"}
              </Button>
              )}
              {downloadMessage && preparation.phase === "idle" && <p className="reader-more-menu__status" role="status">{downloadMessage}</p>}
              </section>
              <section aria-label="笔记保存与同步">
                <div className="reader-option-heading"><h2><RefreshCw size={17} aria-hidden="true" />笔记同步</h2>
                {!guestExperience && <Button className="reader-option-action" aria-label={!online ? "离线，联网后可同步" : syncing || syncActivity === "running" ? "同步中…" : syncStatus.kind === "failed" ? "重试同步" : "立即同步"} aria-description="获取成员最新笔记，并上传我的修改" isDisabled={!online || syncing || syncActivity === "running" || cloudState === "trashed" || !annotationActions} onPress={() => void manualSync()}>{syncing || syncActivity === "running" ? "同步中…" : syncStatus.kind === "failed" ? "重试" : "同步"}</Button>}
                </div>
                {guestExperience ? <p className="reader-more-menu__status" role="status">{syncStatus.message}</p> : <>
                  <dl className="reader-sync-details">
                    <div><dt>我的修改</dt><dd data-kind={syncStatus.kind} role="status">{syncStatus.message}</dd></div>
                    <div><dt>上次检查云端</dt><dd>{cloudCheck?.scope === workspace.scopeKey ? new Date(cloudCheck.at).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未确认"}</dd></div>
                  </dl>
                </>}
              </section>
              </>}
              <details className="reader-help"><summary>阅读帮助<ChevronDown size={15} aria-hidden="true" /></summary>
                <p className="reader-more-menu__status">轻点中央显示工具；点按两侧或左右滑动翻页。编辑时双指移动或缩放当前页，点勾号完成后继续翻页。笔记同步与离线副本分别准备。</p>
                <Button onPress={() => { setMoreOpen(false); setDiagnosticOpen(true); }}>故障诊断</Button>
              </details>
            </Dialog>
            </Popover>
          ) : null}
        </header>
      ) : null}

      {!editing && chromeVisible ? (
        <>
          <PageNavigatorPanel
            key={score.currentVersion.id}
            document={document}
            currentPage={currentPage}
            onSelect={page => { setZoom(1); setCurrentPage(page); }}
          />
        </>
      ) : null}

      {editing && editor && annotationInteraction === "idle" ? (
        <Suspense fallback={<p role="status">正在准备笔记工具…</p>}>
          {/* Normal checkpoints and history are serialized by the editor;
              toggling disabled here makes the toolbar flash on every save. */}
          <ReaderEditingControls
            isDisabled={persistence === "failed"}
            editor={editor}
            layers={layers}
            tool={tool}
            toolColor={toolColor}
            toolStyle={toolStyle}
            onStyleChange={setToolStyle}
            onColorChange={setToolColor}
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
      {exportOpen && workspace && <ExportDialog layers={layers} workspace={workspace} source={document} versionId={score.currentVersion.id} fileName={score.fileName} authenticatedUserId={identity.authenticatedUserId} onClose={() => setExportOpen(false)} />}
      {!editing && readerPanel === "layers" ? (
        <ModalOverlay className="reader-panel-backdrop" isOpen isDismissable
          onOpenChange={(open) => { if (!open) setReaderPanel(null); }}>
          <Modal className="reader-panel reader-layers-dialog">
            <Dialog preserveOnNavigate aria-label={"笔记图层"} className="reader-layers-content">
              <header className="reader-panel__header">
                <strong>{"笔记图层"}</strong>
                <Button className="icon-button" aria-label="关闭笔记显示" onPress={() => setReaderPanel(null)}>
                  <X aria-hidden="true" size={21} />
                </Button>
              </header>
              <Suspense fallback={<p role="status">正在准备图层…</p>}>
                <ReaderLayerPanel
                  key={workspace.scopeKey}
                  workspace={workspace}
                  layers={activeAnnotations?.layers ?? []}
                  signedIn={Boolean(identity.authenticatedUserId) && !guestExperience}
                />
              </Suspense>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}

      {!editing && conflicts.length > 0 ? (
        <aside className="annotation-conflicts" aria-label="本地笔记冲突">
          <strong>仍有 {conflicts.length} 项本机冲突待处理</strong>
          <p>同一笔记的云端版本已经变化；以下是保留在这台设备上的版本。</p>
          {conflicts.map((conflict) => {
            const layer = layers.find(layer => layer.id === conflict.layerId);
            const layerName = layer ? (layer.name) : "未知图层";
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
      {!editing && (syncStatus.kind === "failed" || syncStatus.kind === "risk") ? (
        <aside className="annotation-conflicts" aria-label="笔记同步异常">
          <strong>{syncStatus.message}</strong>
          <div>
            <Link className="text-button" to="/diagnostics">查看原因</Link>
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
            fitRequest={fitRequest}
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
    </ReaderPresentationContext.Provider>
  );
}

function readBooleanPreference(key: string) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
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
