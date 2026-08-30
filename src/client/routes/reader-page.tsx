import { useLiveQuery } from "dexie-react-hooks";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import {
  annotationLayerListResponseSchema,
  type AnnotationLayerSummary,
} from "../../shared/annotations";
import { scoreListResponseSchema, type ScoreSummary } from "../../shared/scores";
import type { AnnotationTool } from "../annotations/annotation-overlay";
import {
  cacheAnnotationLayers,
  discardAnnotationConflict,
  queueScoreDrafts,
  reapplyAnnotationConflict,
  updateCachedLayer,
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
  annotationScopeKey,
  findActiveOfflineScore,
  localDatabase,
  type OfflineScoreRecord,
} from "../platform/local-database";
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

type ReaderPanel = "pages" | "layers";

export default function ReaderPage() {
  const { choirId = "", scoreId = "" } = useParams();
  const session = authClient.useSession();
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const [offline, setOffline] = useState<OfflineScoreRecord | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [source, setSource] = useState<string | ArrayBuffer | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>("text");
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
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
  const scopeKey = annotationScopeKey(choirId, scoreId);
  const layers = useLiveQuery(
    () =>
      localDatabase.annotationLayers
        .where("scopeKey")
        .equals(scopeKey)
        .toArray()
        .then((entries) => entries.sort(compareLayers)),
    [scopeKey],
    [],
  );
  const annotations = useLiveQuery(
    () => localDatabase.annotations.where("scopeKey").equals(scopeKey).toArray(),
    [scopeKey],
    [],
  );
  const pendingCount = useLiveQuery(
    () => localDatabase.annotationOutbox.where("scopeKey").equals(scopeKey).count(),
    [scopeKey],
    0,
  );
  const conflicts = useLiveQuery(
    () => localDatabase.annotationConflicts.where("scopeKey").equals(scopeKey).toArray(),
    [scopeKey],
    [],
  );
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
    let active = true;
    void (async () => {
      setLoadingError(null);
      const local = await findActiveOfflineScore(choirId, scoreId).catch(
        () => undefined,
      );
      if (local) await restoreOfflineAnnotationSnapshot(local).catch(() => undefined);
      if (active) setOffline(local ?? null);

      try {
        const response = await fetch(`/api/choirs/${choirId}/scores`);
        if (!response.ok) throw new Error("Score list unavailable");
        const payload = scoreListResponseSchema.parse(await response.json());
        const current = payload.scores.find((item) => item.id === scoreId);
        if (!current) throw new Error("Score unavailable");
        if (!active) return;
        setScore(current);
        setSource(`/api/choirs/${choirId}/scores/${scoreId}/pdf`);
      } catch {
        if (!active) return;
        if (local) {
          setScore(scoreFromOffline(local));
          setSource(await local.blob.arrayBuffer());
        } else {
          setLoadingError("无法打开乐谱。请检查网络与当前访问权限。");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [choirId, scoreId]);

  useEffect(() => {
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
          .equals(scopeKey)
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
        await cacheAnnotationLayers(choirId, scoreId, layersToCache);
        if (active) setCanManageLayers(body.permissions.canManageLayers);
        await syncAnnotations(choirId, scoreId, { pull: true });
        if (active) setSyncMessage("批注已同步");
      } catch {
        if (active) setSyncMessage("当前使用本机批注；联网后可立即同步");
      }
    })();
    return () => {
      active = false;
    };
  }, [choirId, scopeKey, scoreId, session.data?.user.id]);

  useEffect(() => {
    const drain = () => {
      if (!navigator.onLine || globalThis.document.visibilityState === "hidden") return;
      void syncAnnotations(choirId, scoreId, { pull: false }).catch(() => undefined);
    };
    window.addEventListener("online", drain);
    globalThis.document.addEventListener("visibilitychange", drain);
    return () => {
      window.removeEventListener("online", drain);
      globalThis.document.removeEventListener("visibilitychange", drain);
    };
  }, [choirId, scoreId]);

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
    };
  }, [setCurrentPage, source]);

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
    if (!score) return;
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
        .equals(scopeKey)
        .toArray();
      const currentById = new Map(currentLayers.map((layer) => [layer.id, layer]));
      await cacheAnnotationLayers(
        choirId,
        scoreId,
        session.data?.user.id
          ? layerBody.layers
          : layerBody.layers.map((layer) => ({
              ...layer,
              visible: currentById.get(layer.id)?.visible ?? layer.visible,
              colorOverride:
                currentById.get(layer.id)?.colorOverride ?? layer.colorOverride,
            })),
      );
      await syncAnnotations(choirId, scoreId, { pull: true });
      const annotationSnapshot = await captureOfflineAnnotationSnapshot(
        choirId,
        scoreId,
      );
      const record = {
        key: `${choirId}:${scoreId}:${score.currentVersion.id}`,
        choirId,
        scoreId,
        versionId: score.currentVersion.id,
        title: score.title,
        sha256: score.currentVersion.sha256,
        pageCount: score.currentVersion.pageCount,
        blob: new Blob([data], { type: "application/pdf" }),
        annotationSnapshot,
      };
      await activateVerifiedOfflineScore(record);
      const activeRecord = await findActiveOfflineScore(choirId, scoreId);
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
    setEditing(false);
    endAnnotationEditSession();
    if (editingOrigin) {
      setLayout(editingOrigin.layout);
      setCurrentPage(editingOrigin.page);
      setZoom(editingOrigin.zoom);
      setContinuousRestorePosition(editingOrigin.continuousPosition);
    }
    setEditingOrigin(null);
    const queued = await queueScoreDrafts(choirId, scoreId);
    if (queued === 0) {
      setSyncMessage("没有需要保存的修改");
      return;
    }
    if (!navigator.onLine) {
      setSyncMessage(`已保存到本机，${queued} 项待同步`);
      return;
    }
    setSyncing(true);
    try {
      await syncAnnotations(choirId, scoreId, { pull: false });
      const remaining = await localDatabase.annotationOutbox
        .where("scopeKey")
        .equals(scopeKey)
        .count();
      const conflictCount = await localDatabase.annotationConflicts
        .where("scopeKey")
        .equals(scopeKey)
        .count();
      setSyncMessage(
        conflictCount > 0
          ? `${conflictCount} 项只保留在本机，需要处理冲突`
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
    setSyncing(true);
    try {
      await syncAnnotations(choirId, scoreId, { pull: true });
      setSyncMessage("批注已同步");
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
    if (strategy === "discard") {
      await discardAnnotationConflict(opId);
      setSyncMessage("已放弃本机冲突版本");
      return;
    }
    await reapplyAnnotationConflict(opId, strategy === "keep-both");
    const queued = await queueScoreDrafts(choirId, scoreId);
    if (!navigator.onLine) {
      setSyncMessage(`冲突处理已保存到本机，${queued} 项待同步`);
      return;
    }
    try {
      await syncAnnotations(choirId, scoreId, { pull: false });
      setSyncMessage("冲突处理已同步");
    } catch {
      setSyncMessage(`冲突处理已保存到本机，${queued} 项待同步`);
    }
  };

  if (loadingError) {
    return (
      <main className="page-shell compact-page">
        <p className="eyebrow">乐谱阅读器</p>
        <h1>无法打开</h1>
        <p className="hero__copy" role="alert">
          {loadingError}
        </p>
        <Link className="primary-link" to={`/choirs/${choirId}`}>
          返回合唱团
        </Link>
      </main>
    );
  }

  if (!score || !document) {
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
    choirId,
    scoreId,
    layers,
    annotations,
    editing,
    tool,
    activeLayerId,
  };

  return (
    <main className="reader-shell">
      <h1 className="visually-hidden">{score.title}</h1>
      {!editing && chromeVisible ? (
        <header className="reader-chrome" aria-label="阅读器控制">
          <Link className="reader-chrome__back" to={`/choirs/${choirId}`}>
            返回
          </Link>
          <strong className="reader-chrome__title">{score.title}</strong>
          <div className="reader-chrome__actions">
            <Button onPress={() => openReaderPanel("pages")}>
              第 {currentPage} / {document.numPages} 页
            </Button>
            {layers.some((layer) => layer.canEdit) ? (
              <Button onPress={beginEditing}>编辑</Button>
            ) : null}
            <Button
              aria-expanded={moreOpen}
              onPress={() => setMoreOpen((open) => !open)}
            >
              更多
            </Button>
          </div>
          {moreOpen ? (
            <aside className="reader-more-menu" aria-label="更多阅读选项">
              <div className="segmented-control" aria-label="页面布局">
                <Button
                  aria-pressed={layout === "page"}
                  onPress={() => selectLayout("page")}
                >
                  翻页
                </Button>
                <Button
                  aria-pressed={layout === "continuous"}
                  onPress={() => selectLayout("continuous")}
                >
                  连续滚动
                </Button>
              </div>
              <div className="reader-more-menu__zoom" aria-label="缩放控制">
                <Button onPress={() => setZoom(1)}>适合页面</Button>
                <Button onPress={() => setZoom((value) => Math.max(1, value - 0.25))}>
                  缩小
                </Button>
                <span aria-live="polite">{Math.round(zoom * 100)}%</span>
                <Button onPress={() => setZoom((value) => Math.min(3, value + 0.25))}>
                  放大
                </Button>
              </div>
              <Button onPress={() => openReaderPanel("layers")}>页面与图层</Button>
              <Button
                isDisabled={downloading}
                onPress={() => void downloadOffline()}
              >
                {downloading ? "正在校验…" : "下载离线副本"}
              </Button>
              <Button isDisabled={syncing} onPress={() => void manualSync()}>
                {syncing ? "同步中…" : "立即同步"}
              </Button>
              <p className="reader-more-menu__status" role="status">
                {downloadMessage ?? syncMessage ?? "尚未同步批注"}
                {pendingCount > 0 ? ` · ${pendingCount} 项待同步` : ""}
                {conflicts.length > 0 ? ` · ${conflicts.length} 项本地冲突` : ""}
              </p>
            </aside>
          ) : null}
        </header>
      ) : null}

      {editing ? (
        <>
          <header className="reader-edit-header">
            <div>
              <strong>{score.title}</strong>
              <span>编辑模式 · 第 {currentPage} 页</span>
            </div>
            <Button onPress={() => void finishEditing()}>完成</Button>
          </header>
          <EditingControls
            choirId={choirId}
            scoreId={scoreId}
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
            aria-label="页面与图层"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="reader-panel__header">
              <div className="segmented-control" aria-label="辅助面板">
                <Button
                  aria-pressed={readerPanel === "pages"}
                  onPress={() => setReaderPanel("pages")}
                >
                  页面
                </Button>
                <Button
                  aria-pressed={readerPanel === "layers"}
                  onPress={() => setReaderPanel("layers")}
                >
                  图层
                </Button>
              </div>
              <Button aria-label="关闭页面与图层" onPress={() => setReaderPanel(null)}>
                关闭
              </Button>
            </header>
            {readerPanel === "pages" ? (
              <PageNavigatorPanel
                document={document}
                currentPage={currentPage}
                onSelect={(page) => {
                  goToPage(page);
                  setReaderPanel(null);
                }}
              />
            ) : (
              <LayerPanel
                choirId={choirId}
                scoreId={scoreId}
                scopeKey={scopeKey}
                layers={layers}
                canManageLayers={canManageLayers}
                signedIn={Boolean(session.data?.user.id)}
              />
            )}
          </aside>
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <aside className="annotation-conflicts" aria-label="本地批注冲突">
          <strong>{conflicts.length} 项修改没有上传</strong>
          {conflicts.map((conflict) => (
            <div key={conflict.opId}>
              <span>同一批注已被其他编辑者修改。</span>
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
  choirId,
  scoreId,
  layers,
  tool,
  activeLayerId,
  onToolChange,
  onLayerChange,
}: {
  choirId: string;
  scoreId: string;
  layers: AnnotationLayerSummary[];
  tool: AnnotationTool;
  activeLayerId: string | null;
  onToolChange(tool: AnnotationTool): void;
  onLayerChange(layerId: string): void;
}) {
  return (
    <section className="annotation-controls" aria-label="批注工具">
      <label>
        编辑层
        <select
          value={activeLayerId ?? ""}
          onChange={(event) => onLayerChange(event.target.value)}
        >
          {layers
            .filter((layer) => layer.canEdit)
            .map((layer) => (
              <option value={layer.id} key={layer.id}>
                {layer.name}
              </option>
            ))}
        </select>
      </label>
      <div className="segmented-control" aria-label="批注工具">
        {(["text", "ink", "eraser"] as const).map((entry) => (
          <Button
            aria-pressed={tool === entry}
            key={entry}
            onPress={() => onToolChange(entry)}
          >
            {{ text: "文本", ink: "画笔", eraser: "整条橡皮" }[entry]}
          </Button>
        ))}
      </div>
      <Button
        onPress={() =>
          activeLayerId
            ? void undoAnnotationEdit(choirId, scoreId, activeLayerId)
            : undefined
        }
      >
        撤销
      </Button>
      <Button
        onPress={() =>
          activeLayerId
            ? void redoAnnotationEdit(choirId, scoreId, activeLayerId)
            : undefined
        }
      >
        重做
      </Button>
    </section>
  );
}

function LayerPanel({
  choirId,
  scoreId,
  scopeKey,
  layers,
  canManageLayers,
  signedIn,
}: {
  choirId: string;
  scoreId: string;
  scopeKey: string;
  layers: AnnotationLayerSummary[];
  canManageLayers: boolean;
  signedIn: boolean;
}) {
  const updatePreference = async (
    layer: AnnotationLayerSummary,
    changes: Partial<Pick<AnnotationLayerSummary, "visible" | "colorOverride">>,
  ) => {
    await updateCachedLayer(scopeKey, layer.id, changes);
    if (!signedIn) return;
    const response = await fetch(
      `/api/choirs/${choirId}/scores/${scoreId}/layers/${layer.id}/preference`,
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
                        choirId={choirId}
                        scoreId={scoreId}
                        scopeKey={scopeKey}
                        layer={layer}
                      />
                      <LayerGrantManager
                        choirId={choirId}
                        scoreId={scoreId}
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
                void fetch(`/api/choirs/${choirId}/scores/${scoreId}/layers`, {
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
                      layer: { id: string; kind: "shared"; name: string; defaultColor: string; sortOrder: number };
                    };
                    await cacheAnnotationLayers(choirId, scoreId, [
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
  choirId,
  scoreId,
  scopeKey,
  layer,
}: {
  choirId: string;
  scoreId: string;
  scopeKey: string;
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
            `/api/choirs/${choirId}/scores/${scoreId}/layers/${layer.id}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(update),
            },
          ).then(async (response) => {
            if (!response.ok) throw new Error("layer_update_failed");
            await localDatabase.annotationLayers.update(`${scopeKey}:${layer.id}`, update);
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

function scoreFromOffline(record: OfflineScoreRecord): ScoreSummary {
  return {
    id: record.scoreId,
    choirId: record.choirId,
    title: record.title,
    composer: null,
    arranger: null,
    sortOrder: 0,
    status: "published",
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
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-CN");
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}
