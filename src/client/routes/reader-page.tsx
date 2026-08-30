import { useVirtualizer } from "@tanstack/react-virtual";
import { useLiveQuery } from "dexie-react-hooks";
import {
  type PointerEvent as ReactPointerEvent,
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
import {
  AnnotationOverlay,
  type AnnotationTool,
} from "../annotations/annotation-overlay";
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
  type LocalAnnotationRecord,
  type OfflineScoreRecord,
} from "../platform/local-database";
import {
  loadPdfDocument,
  type PDFDocumentProxy,
} from "../reader/pdf-document";
import { PdfPageCanvas } from "../reader/pdf-page";

type ReaderLayout = "page" | "continuous";

export default function ReaderPage() {
  const { choirId = "", scoreId = "" } = useParams();
  const session = authClient.useSession();
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const [offline, setOffline] = useState<OfflineScoreRecord | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [source, setSource] = useState<string | ArrayBuffer | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<AnnotationTool>("text");
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [canManageLayers, setCanManageLayers] = useState(false);
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
  const preferenceKey = `reader-layout:${session.data?.user.id ?? "guest"}:${choirId}:${scoreId}`;
  const [layoutState, setLayoutState] = useState<{
    key: string;
    value: ReaderLayout;
  }>(() => ({ key: preferenceKey, value: readLayoutPreference(preferenceKey) }));
  const layout =
    layoutState.key === preferenceKey
      ? layoutState.value
      : readLayoutPreference(preferenceKey);
  const setLayout = (value: ReaderLayout) =>
    setLayoutState({ key: preferenceKey, value });

  useEffect(() => {
    try {
      localStorage.setItem(preferenceKey, layout);
    } catch {
      // Reader remains usable when browser storage is unavailable.
    }
  }, [layout, preferenceKey]);

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
  }, [source]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        layout !== "page" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setCurrentPage((page) => Math.max(1, page - 1));
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        setCurrentPage((page) =>
          Math.min(document?.numPages ?? page, page + 1),
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [document?.numPages, layout]);

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
    setActiveLayerId(editableLayer.id);
    setTool("text");
    beginAnnotationEditSession();
    setEditing(true);
    setSyncMessage("编辑内容会持续保存在本机");
  };

  const finishEditing = async () => {
    setEditing(false);
    endAnnotationEditSession();
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

  return (
    <main className="reader-shell">
      <header className="reader-toolbar">
        <div className="reader-toolbar__title">
          <Link to={`/choirs/${choirId}`}>返回</Link>
          <div>
            <strong>{score.title}</strong>
            <span>{editing ? "编辑模式" : "阅读模式"}</span>
          </div>
        </div>
        <div className="reader-toolbar__controls" aria-label="阅读器控制">
          <div className="segmented-control" aria-label="页面布局">
            <Button
              aria-pressed={layout === "page"}
              onPress={() => setLayout("page")}
            >
              翻页
            </Button>
            <Button
              aria-pressed={layout === "continuous"}
              onPress={() => setLayout("continuous")}
            >
              连续滚动
            </Button>
          </div>
          <Button
            onPress={() => setZoom((value) => Math.max(0.75, value - 0.25))}
          >
            缩小
          </Button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <Button
            onPress={() => setZoom((value) => Math.min(2, value + 0.25))}
          >
            放大
          </Button>
          <label className="page-number-control">
            第
            <input
              type="number"
              min={1}
              max={document.numPages}
              value={currentPage}
              onChange={(event) =>
                setCurrentPage(
                  clamp(Number(event.target.value), 1, document.numPages),
                )
              }
            />
            / {document.numPages} 页
          </label>
          <Button isDisabled={downloading} onPress={() => void downloadOffline()}>
            {downloading ? "正在校验…" : "下载离线副本"}
          </Button>
          {editing ? (
            <Button onPress={() => void finishEditing()}>完成</Button>
          ) : layers.some((layer) => layer.canEdit) ? (
            <Button onPress={beginEditing}>编辑</Button>
          ) : null}
          <Button isDisabled={syncing} onPress={() => void manualSync()}>
            {syncing ? "同步中…" : "立即同步"}
          </Button>
        </div>
        {hasNewOfflineVersion ? (
          <p className="reader-notice">
            云端已有新版本；完整下载并校验前，原离线副本会继续保留。
          </p>
        ) : null}
        {downloadMessage ? (
          <p className="reader-notice" role="status">
            {downloadMessage}
          </p>
        ) : null}
        {syncMessage || pendingCount > 0 || conflicts.length > 0 ? (
          <p className="reader-notice" role="status">
            {syncMessage ?? ""}
            {pendingCount > 0 ? ` · ${pendingCount} 项待同步` : ""}
            {conflicts.length > 0 ? ` · ${conflicts.length} 项本地冲突` : ""}
          </p>
        ) : null}
      </header>

      <AnnotationControls
        choirId={choirId}
        scoreId={scoreId}
        scopeKey={scopeKey}
        layers={layers}
        editing={editing}
        tool={tool}
        activeLayerId={activeLayerId}
        canManageLayers={canManageLayers}
        signedIn={Boolean(session.data?.user.id)}
        onToolChange={setTool}
        onLayerChange={setActiveLayerId}
      />
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

      <ThumbnailNavigator
        document={document}
        currentPage={currentPage}
        onSelect={setCurrentPage}
      />

      {layout === "page" ? (
        <PageLayout
          document={document}
          currentPage={currentPage}
          zoom={zoom}
          onPageChange={setCurrentPage}
          annotationProps={{
            choirId,
            scoreId,
            layers,
            annotations,
            editing,
            tool,
            activeLayerId,
          }}
        />
      ) : (
        <ContinuousLayout
          document={document}
          currentPage={currentPage}
          zoom={zoom}
          onPageChange={setCurrentPage}
          annotationProps={{
            choirId,
            scoreId,
            layers,
            annotations,
            editing,
            tool,
            activeLayerId,
          }}
        />
      )}
    </main>
  );
}

function AnnotatedPdfPage({
  document,
  pageNumber,
  width,
  annotationProps,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  annotationProps: AnnotationPageProps;
}) {
  return (
    <div className="annotated-pdf-page">
      <PdfPageCanvas document={document} pageNumber={pageNumber} width={width} />
      <AnnotationOverlay
        {...annotationProps}
        key={`${pageNumber}:${annotationProps.editing ? "edit" : "read"}`}
        pageNumber={pageNumber}
      />
    </div>
  );
}

function AnnotationControls({
  choirId,
  scoreId,
  scopeKey,
  layers,
  editing,
  tool,
  activeLayerId,
  canManageLayers,
  signedIn,
  onToolChange,
  onLayerChange,
}: {
  choirId: string;
  scoreId: string;
  scopeKey: string;
  layers: AnnotationLayerSummary[];
  editing: boolean;
  tool: AnnotationTool;
  activeLayerId: string | null;
  canManageLayers: boolean;
  signedIn: boolean;
  onToolChange(tool: AnnotationTool): void;
  onLayerChange(layerId: string): void;
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
    <section className="annotation-controls" aria-label="批注控制">
      {editing ? (
        <>
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
        </>
      ) : (
        <span>阅读模式：批注层不会接收编辑输入</span>
      )}
      <details>
        <summary>图层显示与颜色</summary>
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
      </details>
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

function PageLayout({
  document,
  currentPage,
  zoom,
  onPageChange,
  annotationProps,
}: ReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(containerRef);
  const pointerStart = useRef<{
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const pointerDown = (event: ReactPointerEvent) => {
    if (annotationProps.editing) return;
    pointerStart.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: containerRef.current?.scrollLeft ?? 0,
      scrollTop: containerRef.current?.scrollTop ?? 0,
    };
    if (zoom > 1 && event.pointerType === "mouse") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const pointerMove = (event: ReactPointerEvent) => {
    if (annotationProps.editing) return;
    const start = pointerStart.current;
    const container = containerRef.current;
    if (!start || !container || zoom <= 1 || event.pointerType !== "mouse") {
      return;
    }
    container.scrollLeft = start.scrollLeft - (event.clientX - start.x);
    container.scrollTop = start.scrollTop - (event.clientY - start.y);
  };
  const pointerUp = (event: ReactPointerEvent) => {
    if (annotationProps.editing) return;
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    if (zoom > 1) return;
    const x = event.clientX - start.x;
    const y = event.clientY - start.y;
    if (Math.abs(x) < 50 || Math.abs(x) <= Math.abs(y)) return;
    onPageChange(
      x < 0
        ? Math.min(document.numPages, currentPage + 1)
        : Math.max(1, currentPage - 1),
    );
  };

  return (
    <section className="page-reader" aria-label="翻页阅读">
      <Button
        aria-label="上一页"
        isDisabled={currentPage <= 1}
        onPress={() => onPageChange(Math.max(1, currentPage - 1))}
      >
        ‹
      </Button>
      <div
        className="page-reader__viewport"
        ref={containerRef}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
      >
        <div
          className="page-reader__canvas-stage"
          style={{ width: Math.max(1, width * zoom) }}
        >
          <AnnotatedPdfPage
            document={document}
            pageNumber={currentPage}
            width={Math.max(1, width * zoom)}
            annotationProps={annotationProps}
          />
        </div>
      </div>
      <Button
        aria-label="下一页"
        isDisabled={currentPage >= document.numPages}
        onPress={() =>
          onPageChange(Math.min(document.numPages, currentPage + 1))
        }
      >
        ›
      </Button>
    </section>
  );
}

function ContinuousLayout({
  document,
  currentPage,
  zoom,
  onPageChange,
  annotationProps,
}: ReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(scrollRef);
  const pageWidth = Math.max(1, (width - 32) * zoom);
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: document.numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => pageWidth * 1.35 + 24,
    overscan: 2,
  });

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const target = virtualizer
      .getVirtualItems()
      .find((item) => item.index === currentPage - 1);
    const visible =
      scrollElement &&
      target &&
      target.start >= scrollElement.scrollTop &&
      target.end <= scrollElement.scrollTop + scrollElement.clientHeight;
    if (!visible) {
      virtualizer.scrollToIndex(currentPage - 1, { align: "start" });
    }
  }, [currentPage, virtualizer]);

  return (
    <section
      className="continuous-reader"
      ref={scrollRef}
      onScroll={() => {
        const threshold = (scrollRef.current?.scrollTop ?? 0) + 8;
        const items = virtualizer.getVirtualItems();
        const first =
          items.find((item) => item.end > threshold) ?? items[0];
        if (first) onPageChange(first.index + 1);
      }}
      aria-label="连续滚动阅读"
    >
      <div
        className="continuous-reader__inner"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            className="continuous-reader__page"
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <AnnotatedPdfPage
              document={document}
              pageNumber={item.index + 1}
              width={pageWidth}
              annotationProps={annotationProps}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function ThumbnailNavigator({ document, currentPage, onSelect }: ThumbnailProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: document.numPages,
    getScrollElement: () => stripRef.current,
    estimateSize: () => 96,
    overscan: 3,
  });

  useEffect(() => {
    virtualizer.scrollToIndex(currentPage - 1, { align: "auto" });
  }, [currentPage, virtualizer]);

  return (
    <nav className="thumbnail-strip" ref={stripRef} aria-label="页面缩略图">
      <div
        className="thumbnail-strip__inner"
        style={{ width: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <button
            className="thumbnail-button"
            data-current={item.index + 1 === currentPage || undefined}
            key={item.key}
            onClick={() => onSelect(item.index + 1)}
            style={{ transform: `translateX(${item.start}px)` }}
            aria-label={`前往第 ${item.index + 1} 页`}
          >
            <PdfPageCanvas
              className="pdf-thumbnail"
              document={document}
              pageNumber={item.index + 1}
              width={72}
            />
            <span>{item.index + 1}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function readLayoutPreference(key: string): ReaderLayout {
  try {
    return localStorage.getItem(key) === "continuous" ? "continuous" : "page";
  } catch {
    return "page";
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

interface ReaderProps {
  document: PDFDocumentProxy;
  currentPage: number;
  zoom: number;
  onPageChange(page: number): void;
  annotationProps: AnnotationPageProps;
}

interface AnnotationPageProps {
  choirId: string;
  scoreId: string;
  layers: AnnotationLayerSummary[];
  annotations: LocalAnnotationRecord[];
  editing: boolean;
  tool: AnnotationTool;
  activeLayerId: string | null;
}

interface ThumbnailProps {
  document: PDFDocumentProxy;
  currentPage: number;
  onSelect(page: number): void;
}
