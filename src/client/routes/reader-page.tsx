import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Download,
  Ellipsis,
  Eraser,
  Layers,
  Maximize2,
  Minus,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Rows3,
  Type,
  Undo2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import {
  annotationLayerListResponseSchema,
  defaultSharedLayerSlots,
  type AnnotationLayerSummary,
  type DefaultSharedLayerSlot,
} from "../../shared/annotations";
import {
  scoreCloudStateSchema,
  scoreListResponseSchema,
  type ScoreSummary,
} from "../../shared/scores";
import type { AnnotationTool } from "../annotations/annotation-overlay";
import {
  cacheAnnotationLayers,
  discardAnnotationConflict,
  queueScoreDrafts,
  reapplyAnnotationConflict,
  retryScoreSyncErrors,
  updateCachedLayer,
  updateCachedLayerMetadata,
} from "../annotations/local-annotations";
import { syncAnnotations } from "../annotations/sync";
import {
  captureOfflineAnnotationSnapshot,
  ensureOfflineAppShell,
  restoreOfflineAnnotationSnapshot,
} from "../annotations/offline-snapshot";
import {
  beginAnnotationEditSession,
  endAnnotationEditSession,
  redoAnnotationEdit,
  undoAnnotationEdit,
} from "../annotations/edit-history";
import { authClient } from "../auth/auth-client";
import {
  activateVerifiedOfflineScore,
  findActiveOfflineScore,
  localDatabase,
  type OfflineScoreRecord,
} from "../platform/local-database";
import {
  isLocalWorkspaceActive,
  localWorkspaceRecordKey,
  resolveLocalWorkspace,
  type LocalWorkspace,
} from "../platform/local-workspace";
import {
  loadPdfDocument,
  type PDFDocumentProxy,
} from "../reader/pdf-document";
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

type ReaderPanel = "layers";

export default function ReaderPage() {
  const { choirId = "", scoreId = "" } = useParams();
  const session = authClient.useSession();
  const [resolvedWorkspace, setResolvedWorkspace] =
    useState<LocalWorkspace | null>(null);
  const [loadedScopeKey, setLoadedScopeKey] = useState<string | null>(null);
  const workspaceIsActive = useLiveQuery(
    () => resolvedWorkspace
      ? isLocalWorkspaceActive(resolvedWorkspace)
      : false,
    [resolvedWorkspace?.scopeKey],
    false,
  );
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const [offline, setOffline] = useState<OfflineScoreRecord | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentScopeKey, setDocumentScopeKey] = useState<string | null>(null);
  const [source, setSource] = useState<string | ArrayBuffer | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>("text");
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [cloudState, setCloudState] = useState<
    "checking" | "active" | "trashed" | "unavailable"
  >("checking");
  const [syncing, setSyncing] = useState(false);
  const [canManageLayers, setCanManageLayers] = useState(false);
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
    if (session.isPending) return;
    let active = true;
    void resolveLocalWorkspace({
      authenticatedUserId: session.data?.user.id ?? null,
      choirId,
      scoreId,
    }).then((workspace) => {
      if (active) setResolvedWorkspace(workspace);
    });
    return () => {
      active = false;
    };
  }, [choirId, scoreId, session.data?.user.id, session.isPending]);

  const workspace =
    resolvedWorkspace && workspaceIsActive
      ? resolvedWorkspace
      : null;
  const layerQuery = useLiveQuery(
    async () => ({
      scopeKey: workspace?.scopeKey ?? null,
      entries: workspace
      ? await localDatabase.annotationLayers
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .toArray()
        .then((entries) => entries.sort(compareLayers))
      : [],
    }),
    [workspace?.scopeKey],
    { scopeKey: null, entries: [] },
  );
  const annotationQuery = useLiveQuery(
    async () => ({
      scopeKey: workspace?.scopeKey ?? null,
      entries: workspace
        ? await localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey).toArray()
        : [],
    }),
    [workspace?.scopeKey],
    { scopeKey: null, entries: [] },
  );
  const pendingQuery = useLiveQuery(
    async () => ({
      scopeKey: workspace?.scopeKey ?? null,
      count: workspace
        ? await localDatabase.annotationOutbox.where("scopeKey").equals(workspace.scopeKey).count()
        : 0,
    }),
    [workspace?.scopeKey],
    { scopeKey: null, count: 0 },
  );
  const conflictQuery = useLiveQuery(
    async () => ({
      scopeKey: workspace?.scopeKey ?? null,
      entries: workspace
        ? await localDatabase.annotationConflicts.where("scopeKey").equals(workspace.scopeKey).toArray()
        : [],
    }),
    [workspace?.scopeKey],
    { scopeKey: null, entries: [] },
  );
  const syncErrorQuery = useLiveQuery(
    async () => ({
      scopeKey: workspace?.scopeKey ?? null,
      count: workspace
      ? await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([workspace.scopeKey, "sync-error"])
        .count()
      : 0,
    }),
    [workspace?.scopeKey],
    { scopeKey: null, count: 0 },
  );
  const layers = layerQuery.scopeKey === workspace?.scopeKey ? layerQuery.entries : [];
  const annotations =
    annotationQuery.scopeKey === workspace?.scopeKey ? annotationQuery.entries : [];
  const pendingCount =
    pendingQuery.scopeKey === workspace?.scopeKey ? pendingQuery.count : 0;
  const conflicts =
    conflictQuery.scopeKey === workspace?.scopeKey ? conflictQuery.entries : [];
  const syncErrorCount =
    syncErrorQuery.scopeKey === workspace?.scopeKey ? syncErrorQuery.count : 0;
  const { layout, currentPage, setLayout, setCurrentPage } =
    useReaderPreferences({
      identity: session.data?.user.id ?? "guest",
      choirId,
      scoreId,
    });

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
    if (!workspace) return;
    let active = true;
    void (async () => {
      setScore(null);
      setOffline(null);
      setSource(null);
      setDocument(null);
      setDocumentScopeKey(null);
      setCanManageLayers(false);
      setEditing(false);
      setActiveLayerId(null);
      endAnnotationEditSession();
      setLoadingError(null);
      setCloudState("checking");
      const local = await findActiveOfflineScore(workspace.ownerKey, choirId, scoreId).catch(
        () => undefined,
      );
      if (local) await restoreOfflineAnnotationSnapshot(workspace, local).catch(() => undefined);
      if (active) setOffline(local ?? null);

      try {
        const lookup = await lookupScoreCloudState(choirId, scoreId);
        if (lookup.state === "trashed") {
          setCloudState("trashed");
          if (!local) {
            setLoadedScopeKey(workspace.scopeKey);
            setLoadingError("这份乐谱已移入回收站，当前设备没有可用的离线副本。");
            return;
          }
          setSyncMessage(
            "这份乐谱已移入回收站；本机离线副本和未同步批注仍保留，恢复后可继续同步。",
          );
          throw new Error("Score unavailable");
        }
        if (lookup.state !== "active") throw new Error("Score unavailable");
        if (!active) return;
        setCloudState("active");
        setLoadedScopeKey(workspace.scopeKey);
        setScore(lookup.score);
        setSource(`/api/choirs/${choirId}/scores/${scoreId}/pdf`);
      } catch {
        if (!active) return;
        setCloudState((current) => (current === "trashed" ? current : "unavailable"));
        if (local) {
          setLoadedScopeKey(workspace.scopeKey);
          setScore(scoreFromOffline(local));
          setSource(await local.blob.arrayBuffer());
        } else {
          setLoadedScopeKey(workspace.scopeKey);
          setLoadingError("无法打开乐谱。请检查网络与当前访问权限。");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [choirId, scoreId, workspace]);

  useEffect(() => {
    if (!workspace) return;
    if (cloudState === "checking") return;
    if (cloudState === "trashed") return;
    let active = true;
    void (async () => {
      try {
        const layerResponse = await fetch(
          `/api/choirs/${choirId}/scores/${scoreId}/layers`,
        );
        if (!layerResponse.ok) throw new Error("layers unavailable");
        const body = annotationLayerListResponseSchema.parse(
          await layerResponse.json(),
        );
        const previousLayers = await localDatabase.annotationLayers
          .where("scopeKey")
          .equals(workspace.scopeKey)
          .toArray();
        const previousById = new Map(previousLayers.map((layer) => [layer.id, layer]));
        const layersToCache = session.data?.user.id
          ? body.layers
          : body.layers.map((layer) => ({
              ...layer,
              visible: previousById.get(layer.id)?.visible ?? layer.visible,
              colorOverride:
                previousById.get(layer.id)?.colorOverride ?? layer.colorOverride,
            }));
        await cacheAnnotationLayers(workspace, layersToCache);
        if (active) setCanManageLayers(body.permissions.canManageLayers);
        await syncAnnotations(workspace, { pull: true });
        if (active) setSyncMessage("批注已同步");
      } catch {
        if (active) setSyncMessage("当前使用本机批注；联网后可立即同步");
      }
    })();
    return () => {
      active = false;
    };
  }, [choirId, cloudState, scoreId, session.data?.user.id, workspace]);

  useEffect(() => {
    if (!workspace) return;
    let active = true;
    const revalidateAndDrain = () => {
      if (!navigator.onLine || globalThis.document.visibilityState === "hidden") return;
      void lookupScoreCloudState(choirId, scoreId)
        .then(async (lookup) => {
          if (!active) return;
          if (lookup.state === "trashed") {
            setCloudState("trashed");
            setSyncMessage(
              "这份乐谱已移入回收站；本机离线副本和未同步批注仍保留，恢复后可继续同步。",
            );
            return;
          }
          if (lookup.state !== "active") return;
          setCloudState("active");
          setScore(lookup.score);
          setSource(`/api/choirs/${choirId}/scores/${scoreId}/pdf`);
          await syncAnnotations(workspace, { pull: false });
        })
        .catch(() => undefined);
    };
    window.addEventListener("online", revalidateAndDrain);
    globalThis.document.addEventListener("visibilitychange", revalidateAndDrain);
    return () => {
      active = false;
      window.removeEventListener("online", revalidateAndDrain);
      globalThis.document.removeEventListener("visibilitychange", revalidateAndDrain);
    };
  }, [choirId, scoreId, workspace]);

  useEffect(() => {
    if (!source) return;
    let active = true;
    let destroyOpened: (() => Promise<void>) | undefined;
    void loadPdfDocument(source)
      .then((opened) => {
        const nextDocument = opened.document;
        destroyOpened = opened.destroy;
        if (active) {
          setDocument(nextDocument);
          setDocumentScopeKey(workspace?.scopeKey ?? null);
          setCurrentPage((page) => Math.min(page, nextDocument.numPages));
        }
      })
      .catch(() => {
        if (active) setLoadingError("PDF 无法解析或文件暂时不可用。");
      });
    return () => {
      active = false;
      void destroyOpened?.();
      setDocument(null);
      setDocumentScopeKey(null);
    };
  }, [setCurrentPage, source, workspace?.scopeKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        layout !== "page" ||
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
        setCurrentPage((page) => Math.max(1, page - 1));
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        setZoom(1);
        setCurrentPage((page) =>
          Math.min(document?.numPages ?? page, page + 1),
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [document?.numPages, editing, layout, setCurrentPage]);

  const downloadOffline = async () => {
    if (!score || !workspace) return;
    setDownloading(true);
    setDownloadMessage(null);
    try {
      const response = await fetch(
        `/api/choirs/${choirId}/scores/${scoreId}/versions/${score.currentVersion.id}/pdf`,
      );
      if (!response.ok) throw new Error("Download failed");
      const data = await response.arrayBuffer();
      const actualHash = await sha256Hex(data);
      if (actualHash !== score.currentVersion.sha256) {
        throw new Error("Checksum mismatch");
      }
      await ensureOfflineAppShell();
      const layerResponse = await fetch(
        `/api/choirs/${choirId}/scores/${scoreId}/layers`,
      );
      if (!layerResponse.ok) throw new Error("Layer download failed");
      const layerBody = annotationLayerListResponseSchema.parse(
        await layerResponse.json(),
      );
      const currentLayers = await localDatabase.annotationLayers
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .toArray();
      const currentById = new Map(currentLayers.map((layer) => [layer.id, layer]));
      await cacheAnnotationLayers(
        workspace,
        session.data?.user.id
          ? layerBody.layers
          : layerBody.layers.map((layer) => ({
              ...layer,
              visible: currentById.get(layer.id)?.visible ?? layer.visible,
              colorOverride:
                currentById.get(layer.id)?.colorOverride ?? layer.colorOverride,
            })),
      );
      await syncAnnotations(workspace, { pull: true });
      const annotationSnapshot = await captureOfflineAnnotationSnapshot(workspace);
      const record = {
        key: localWorkspaceRecordKey(workspace, score.currentVersion.id),
        ...workspace,
        versionId: score.currentVersion.id,
        fileName: score.fileName,
        sha256: score.currentVersion.sha256,
        pageCount: score.currentVersion.pageCount,
        blob: new Blob([data], { type: "application/pdf" }),
        annotationSnapshot,
      };
      await activateVerifiedOfflineScore(record);
      const activeRecord = await findActiveOfflineScore(workspace.ownerKey, choirId, scoreId);
      setOffline(activeRecord ?? null);
      if (typeof source !== "string" && activeRecord) {
        setSource(await activeRecord.blob.arrayBuffer());
      }
      setDownloadMessage("离线副本已完整校验，可以离线打开。");
    } catch {
      setDownloadMessage("离线下载未完成，现有离线版本没有切换。");
    } finally {
      setDownloading(false);
    }
  };

  const beginEditing = () => {
    if (cloudState === "trashed") {
      setSyncMessage("乐谱在回收站中，不能继续编辑；本机未同步批注仍会保留。");
      return;
    }
    const editableLayer = layers.find((layer) => layer.canEdit);
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
    setChromeVisible(false);
    setMoreOpen(false);
    setReaderPanel(null);
    setActiveLayerId(editableLayer.id);
    setTool("text");
    beginAnnotationEditSession();
    setEditing(true);
    setSyncMessage("编辑内容会持续保存在本机");
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
      setSyncMessage("没有需要保存的修改");
      return;
    }
    if (!navigator.onLine) {
      setSyncMessage(`已保存到本机，${queued} 项待同步`);
      return;
    }
    if (cloudState !== "active") {
      setSyncMessage(`已保存到本机，${queued} 项待同步`);
      return;
    }
    setSyncing(true);
    try {
      await syncAnnotations(workspace, { pull: false });
      const remaining = await localDatabase.annotationOutbox
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .count();
      const conflictCount = await localDatabase.annotationConflicts
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .count();
      const syncErrors = await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([workspace.scopeKey, "sync-error"])
        .count();
      setSyncMessage(
        conflictCount > 0
          ? `${conflictCount} 项只保留在本机，需要处理冲突`
          : syncErrors > 0
            ? `${syncErrors} 项批注同步异常，本机版本仍然保留`
          : remaining > 0
            ? `${remaining} 项待同步`
            : "保存成功，批注已同步",
      );
    } catch {
      setSyncMessage(`已保存到本机，${queued} 项待同步`);
    } finally {
      setSyncing(false);
    }
  };

  const manualSync = async () => {
    if (!workspace) return;
    if (cloudState === "trashed") {
      setSyncMessage("乐谱在回收站中，已停止云端同步；本机内容仍然保留。");
      return;
    }
    setSyncing(true);
    try {
      await retryScoreSyncErrors(workspace);
      await queueScoreDrafts(workspace);
      await syncAnnotations(workspace, { pull: true });
      const remainingErrors = await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([workspace.scopeKey, "sync-error"])
        .count();
      setSyncMessage(
        remainingErrors > 0
          ? `${remainingErrors} 项批注同步异常，稍后可重试`
          : "批注已同步",
      );
    } catch {
      setSyncMessage("同步未完成，本机内容仍然保留");
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
      setSyncMessage("已放弃本机冲突版本");
      return;
    }
    await reapplyAnnotationConflict(workspace, opId, strategy === "keep-both");
    const queued = await queueScoreDrafts(workspace);
    if (!navigator.onLine) {
      setSyncMessage(`冲突处理已保存到本机，${queued} 项待同步`);
      return;
    }
    try {
      await syncAnnotations(workspace, { pull: false });
      setSyncMessage("冲突处理已同步");
    } catch {
      setSyncMessage(`冲突处理已保存到本机，${queued} 项待同步`);
    }
  };

  if (!workspace || loadedScopeKey !== workspace.scopeKey || loadingError) {
    if (!workspace) return <p className="route-loading">正在打开本机工作区…</p>;
    return (
      <main className="page-shell compact-page">
        <p className="eyebrow">乐谱阅读器</p>
        <h1>无法打开</h1>
        <p className="hero__copy" role="alert">
          {loadingError}
        </p>
        <Link className="primary-link" to={`/choirs/${choirId}`}>
          返回云盘
        </Link>
      </main>
    );
  }

  if (!score || !document || documentScopeKey !== workspace.scopeKey) {
    return <p className="route-loading">正在加载乐谱…</p>;
  }

  const hasNewOfflineVersion =
    offline && offline.versionId !== score.currentVersion.id;
  const goToPage = (page: number) => {
    setZoom(1);
    setCurrentPage(clamp(page, 1, document.numPages));
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
  const annotationPageProps: AnnotationPageProps = {
    workspace,
    layers,
    annotations,
    editing,
    tool,
    activeLayerId,
  };

  return (
    <main className="reader-shell">
      <h1 className="visually-hidden">{score.fileName}</h1>
      {cloudState === "trashed" ? (
        <aside className="reader-alert reader-alert--trash" role="alert">
          乐谱已移入回收站。本机离线副本和未同步批注仍保留，恢复后可继续同步。
        </aside>
      ) : null}
      {!editing && chromeVisible ? (
        <header className="reader-chrome" aria-label="阅读器控制">
          <Link
            aria-label="返回云盘"
            className="reader-chrome__back reader-icon-button"
            to={`/choirs/${choirId}`}
          >
            <ArrowLeft aria-hidden="true" size={22} />
          </Link>
          <strong className="reader-chrome__title">{score.fileName}</strong>
          <div className="reader-chrome__actions">
            {cloudState !== "trashed" && layers.some((layer) => layer.canEdit) ? (
              <Button
                aria-label="编辑"
                className="reader-icon-button"
                onPress={beginEditing}
              >
                <Pencil aria-hidden="true" size={21} />
              </Button>
            ) : null}
            <Button
              aria-label="更多"
              aria-expanded={moreOpen}
              className="reader-icon-button"
              onPress={() => setMoreOpen((open) => !open)}
            >
              <Ellipsis aria-hidden="true" size={23} />
            </Button>
          </div>
          {moreOpen ? (
            <aside className="reader-more-menu" aria-label="更多阅读选项">
              <div className="segmented-control" aria-label="页面布局">
                <Button
                  aria-pressed={layout === "page"}
                  onPress={() => selectLayout("page")}
                >
                  <Maximize2 aria-hidden="true" size={18} />
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
              <Button onPress={() => openReaderPanel("layers")}>
                <Layers aria-hidden="true" size={18} />
                <span>图层</span>
              </Button>
              <Button
                isDisabled={downloading || cloudState === "trashed"}
                onPress={() => void downloadOffline()}
              >
                <Download aria-hidden="true" size={18} />
                {downloading ? "正在校验…" : "下载离线副本"}
              </Button>
              <Button isDisabled={syncing || cloudState === "trashed"} onPress={() => void manualSync()}>
                <RefreshCw aria-hidden="true" size={18} />
                {syncing ? "同步中…" : "立即同步"}
              </Button>
              <p className="reader-more-menu__status" role="status">
                {downloadMessage ?? syncMessage ?? "尚未同步批注"}
                {pendingCount > 0 ? ` · ${pendingCount} 项待同步` : ""}
                {conflicts.length > 0 ? ` · ${conflicts.length} 项本地冲突` : ""}
                {syncErrorCount > 0 ? ` · ${syncErrorCount} 项同步异常` : ""}
              </p>
            </aside>
          ) : null}
        </header>
      ) : null}

      {!editing && chromeVisible ? (
        <PageNavigatorPanel
          document={document}
          currentPage={currentPage}
          onSelect={goToPage}
        />
      ) : null}

      {editing ? (
        <>
          <header className="reader-edit-header">
            <div>
              <strong>{score.fileName}</strong>
              <span>编辑模式 · 第 {currentPage} 页</span>
            </div>
            <Button onPress={() => void finishEditing()}>完成</Button>
          </header>
          <EditingControls
            workspace={workspace}
            layers={layers}
            tool={tool}
            activeLayerId={activeLayerId}
            onToolChange={setTool}
            onLayerChange={setActiveLayerId}
          />
        </>
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
      {readerPanel ? (
        <div
          className="reader-panel-backdrop"
          role="presentation"
          onClick={() => setReaderPanel(null)}
        >
          <aside
            className="reader-panel"
            aria-label="图层"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="reader-panel__header">
              <strong>图层</strong>
              <Button aria-label="关闭页面与图层" onPress={() => setReaderPanel(null)}>
                关闭
              </Button>
            </header>
            <LayerPanel
              workspace={workspace}
              layers={layers}
              canManageLayers={canManageLayers}
              signedIn={Boolean(session.data?.user.id)}
            />
          </aside>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <aside className="annotation-conflicts" aria-label="本地批注冲突">
          <strong>{conflicts.length} 项修改没有上传</strong>
          {conflicts.map((conflict) => (
            <div key={conflict.opId}>
              <span>同一批注的云端版本已经变化。</span>
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
          ))}
        </aside>
      ) : null}
      {syncErrorCount > 0 ? (
        <aside className="annotation-conflicts" aria-label="批注同步异常">
          <strong>{syncErrorCount} 项批注同步异常</strong>
          <div>
            <span>这不是协同编辑冲突；本机版本仍然保留。</span>
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
            onPageChange={goToPage}
            onToggleChrome={toggleChrome}
            annotationProps={annotationPageProps}
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
  );
}

function EditingControls({
  workspace,
  layers,
  tool,
  activeLayerId,
  onToolChange,
  onLayerChange,
}: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  tool: AnnotationTool;
  activeLayerId: string | null;
  onToolChange(tool: AnnotationTool): void;
  onLayerChange(layerId: string): void;
}) {
  const defaultLayers = new Map(
    layers
      .filter((layer) => layer.defaultSlot !== null)
      .map((layer) => [layer.defaultSlot, layer]),
  );
  const personalLayer = layers.find((layer) => layer.kind === "personal");
  const customLayers = layers.filter(
    (layer) => layer.kind === "shared" && layer.defaultSlot === null,
  );
  const activeCustom = customLayers.some((layer) => layer.id === activeLayerId)
    ? activeLayerId
    : "";

  return (
    <section className="annotation-controls" aria-label="批注工具">
      <div className="annotation-layer-switcher" aria-label="编辑层">
        {defaultSharedLayerSlots.map((slot) => (
          <LayerSlotButton
            key={slot}
            slot={slot}
            layer={defaultLayers.get(slot)}
            activeLayerId={activeLayerId}
            onLayerChange={onLayerChange}
          />
        ))}
        <LayerSlotButton
          slot="U"
          layer={personalLayer}
          activeLayerId={activeLayerId}
          onLayerChange={onLayerChange}
        />
        {customLayers.length > 0 ? (
          <label className="annotation-custom-layer-select">
            <span className="visually-hidden">其他编辑层</span>
            <select
              aria-label="其他编辑层"
              value={activeCustom ?? ""}
              onChange={(event) => {
                if (event.target.value) onLayerChange(event.target.value);
              }}
            >
              <option value="">…</option>
              {customLayers.map((layer) => (
                <option value={layer.id} key={layer.id} disabled={!layer.canEdit}>
                  {layer.name}{layer.canEdit ? "" : "（只读）"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="segmented-control" aria-label="批注工具">
        {(["text", "ink", "eraser"] as const).map((entry) => (
          <Button
            aria-label={{ text: "文本", ink: "画笔", eraser: "整条橡皮" }[entry]}
            aria-pressed={tool === entry}
            className="annotation-tool-button"
            key={entry}
            onPress={() => onToolChange(entry)}
          >
            <AnnotationToolIcon tool={entry} />
          </Button>
        ))}
      </div>
      <Button
        aria-label="撤销"
        className="annotation-tool-button"
        onPress={() =>
          activeLayerId
            ? void undoAnnotationEdit(workspace, activeLayerId)
            : undefined
        }
      >
        <Undo2 aria-hidden="true" size={20} />
      </Button>
      <Button
        aria-label="重做"
        className="annotation-tool-button"
        onPress={() =>
          activeLayerId
            ? void redoAnnotationEdit(workspace, activeLayerId)
            : undefined
        }
      >
        <Redo2 aria-hidden="true" size={20} />
      </Button>
    </section>
  );
}

function LayerSlotButton({
  slot,
  layer,
  activeLayerId,
  onLayerChange,
}: {
  slot: DefaultSharedLayerSlot | "U";
  layer: AnnotationLayerSummary | undefined;
  activeLayerId: string | null;
  onLayerChange(layerId: string): void;
}) {
  const label =
    slot === "U"
      ? "U，我的批注"
      : `${slot}，${{
          G: "共同关注",
          S: "女高音",
          A: "女低音",
          T: "男高音",
          B: "男低音",
        }[slot]}共享层`;
  return (
    <Button
      aria-label={`${label}${layer?.canEdit ? "" : "，只读"}`}
      aria-pressed={layer?.id === activeLayerId}
      className="annotation-layer-slot"
      isDisabled={!layer?.canEdit}
      onPress={() => (layer ? onLayerChange(layer.id) : undefined)}
    >
      <span>{slot}</span>
      <i
        aria-hidden="true"
        style={{ background: layer?.colorOverride ?? layer?.defaultColor ?? "transparent" }}
      />
    </Button>
  );
}

function AnnotationToolIcon({ tool }: { tool: AnnotationTool }) {
  if (tool === "text") return <Type aria-hidden="true" size={20} strokeWidth={2} />;
  if (tool === "ink") return <Pencil aria-hidden="true" size={20} strokeWidth={2} />;
  return <Eraser aria-hidden="true" size={20} strokeWidth={2} />;
}

function LayerPanel({
  workspace,
  layers,
  canManageLayers,
  signedIn,
}: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  canManageLayers: boolean;
  signedIn: boolean;
}) {
  const updatePreference = async (
    layer: AnnotationLayerSummary,
    changes: Partial<Pick<AnnotationLayerSummary, "visible" | "colorOverride">>,
  ) => {
    await updateCachedLayer(workspace, layer.id, changes);
    if (!signedIn) return;
    const response = await fetch(
      `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/layers/${layer.id}/preference`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      },
    );
    if (!response.ok) throw new Error("preference_update_failed");
  };

  return (
    <section className="reader-layer-panel" aria-label="图层显示与颜色">
      <div className="annotation-layer-list">
          {layers.map((layer) => (
            <div key={layer.id}>
              <label>
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={(event) =>
                    void updatePreference(layer, { visible: event.target.checked })
                  }
                />
                {layer.name}
              </label>
              {layer.kind === "shared" ? (
                <>
                  <label>
                    本机显示颜色
                    <input
                      type="color"
                      value={layer.colorOverride ?? layer.defaultColor}
                      onChange={(event) =>
                        void updatePreference(layer, {
                          colorOverride: event.target.value,
                        })
                      }
                    />
                  </label>
                  {canManageLayers ? (
                    <>
                      <SharedLayerEditor
                        workspace={workspace}
                        layer={layer}
                      />
                      <LayerGrantManager
                        choirId={workspace.choirId}
                        scoreId={workspace.scoreId}
                        layerId={layer.id}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
          ))}
          {canManageLayers ? (
            <form
              className="annotation-layer-create"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                void fetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/layers`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    name: data.get("name"),
                    defaultColor: data.get("color"),
                    sortOrder: layers.filter((layer) => layer.kind === "shared").length,
                  }),
                })
                  .then(async (response) => {
                    if (!response.ok) throw new Error("layer_create_failed");
                    const body = (await response.json()) as {
                      layer: {
                        id: string;
                        kind: "shared";
                        defaultSlot: null;
                        name: string;
                        defaultColor: string;
                        sortOrder: number;
                      };
                    };
                    await cacheAnnotationLayers(workspace, [
                      ...layers,
                      {
                        ...body.layer,
                        visible: true,
                        colorOverride: null,
                        canEdit: true,
                      },
                    ]);
                    form.reset();
                  });
              }}
            >
              <input name="name" aria-label="共享层名称" placeholder="新共享层" required maxLength={80} />
              <input name="color" aria-label="共享层默认颜色" type="color" defaultValue="#a12652" />
              <Button type="submit">新建共享层</Button>
            </form>
          ) : null}
      </div>
    </section>
  );
}

function SharedLayerEditor({
  workspace,
  layer,
}: {
  workspace: LocalWorkspace;
  layer: AnnotationLayerSummary;
}) {
  return (
    <details className="shared-layer-editor">
      <summary>层设置</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const update = {
            name: String(data.get("name") ?? ""),
            defaultColor: String(data.get("defaultColor") ?? ""),
            sortOrder: Number(data.get("sortOrder")),
          };
          void fetch(
            `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/layers/${layer.id}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(update),
            },
          ).then(async (response) => {
            if (!response.ok) throw new Error("layer_update_failed");
            await updateCachedLayerMetadata(workspace, layer.id, update);
          });
        }}
      >
        <input name="name" aria-label={`${layer.name}名称`} defaultValue={layer.name} required maxLength={80} />
        <input
          name="defaultColor"
          aria-label={`${layer.name}默认颜色`}
          type="color"
          defaultValue={layer.defaultColor}
        />
        <input
          name="sortOrder"
          aria-label={`${layer.name}顺序`}
          type="number"
          min={0}
          max={10000}
          defaultValue={layer.sortOrder}
        />
        <Button type="submit">保存层设置</Button>
      </form>
    </details>
  );
}

function LayerGrantManager({
  choirId,
  scoreId,
  layerId,
}: {
  choirId: string;
  scoreId: string;
  layerId: string;
}) {
  const [members, setMembers] = useState<Array<{
    id: string;
    displayName: string;
    role: "admin" | "member";
    granted: boolean;
  }> | null>(null);

  const load = async () => {
    const response = await fetch(
      `/api/choirs/${choirId}/scores/${scoreId}/layers/${layerId}/grants`,
    );
    if (!response.ok) return;
    const body = (await response.json()) as { members: NonNullable<typeof members> };
    setMembers(body.members);
  };

  if (!members) {
    return <Button onPress={() => void load()}>编辑权限</Button>;
  }
  return (
    <div className="annotation-grants">
      {members.map((member) => (
        <label key={member.id}>
          <input
            type="checkbox"
            checked={member.granted}
            disabled={member.role === "admin"}
            onChange={(event) => {
              const granted = event.target.checked;
              setMembers((current) =>
                current?.map((entry) =>
                  entry.id === member.id ? { ...entry, granted } : entry,
                ) ?? null,
              );
              void fetch(
                `/api/choirs/${choirId}/scores/${scoreId}/layers/${layerId}/grants/${member.id}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ granted }),
                },
              );
            }}
          />
          {member.displayName}{member.role === "admin" ? "（管理员）" : ""}
        </label>
      ))}
    </div>
  );
}

function readBooleanPreference(key: string) {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

type ScoreCloudLookup =
  | { state: "active"; score: ScoreSummary }
  | { state: "trashed" }
  | { state: "unavailable" };

async function lookupScoreCloudState(
  choirId: string,
  scoreId: string,
): Promise<ScoreCloudLookup> {
  const response = await fetch(`/api/choirs/${choirId}/scores`);
  if (!response.ok) return { state: "unavailable" };
  const payload = scoreListResponseSchema.parse(await response.json());
  const score = payload.scores.find((item) => item.id === scoreId);
  if (score) return { state: "active", score };

  const statusResponse = await fetch(`/api/choirs/${choirId}/scores/${scoreId}/status`);
  if (!statusResponse.ok) return { state: "unavailable" };
  const status = scoreCloudStateSchema.parse(await statusResponse.json());
  return status.state === "trashed" ? { state: "trashed" } : { state: "unavailable" };
}

function scoreFromOffline(record: OfflineScoreRecord): ScoreSummary {
  return {
    id: record.scoreId,
    choirId: record.choirId,
    fileName: record.fileName,
    updatedAt: record.verifiedAt,
    currentVersion: {
      id: record.versionId,
      versionNumber: 1,
      sizeBytes: record.blob.size,
      sha256: record.sha256,
      etag: "offline",
      pageCount: record.pageCount,
      createdAt: record.verifiedAt,
    },
  };
}

async function sha256Hex(data: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
