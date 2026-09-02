import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Download,
  Ellipsis,
  Eraser,
  Layers,
  Lock,
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
import {
  Button,
  Dialog,
  DialogTrigger,
  Popover,
} from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import {
  annotationLayerListResponseSchema,
  defaultSharedLayerSlots,
  type AnnotationLayerSummary,
  type DefaultSharedLayerSlot,
} from "../../shared/annotations";
import {
  readerScoreBootstrapSchema,
  type ScoreSummary,
} from "../../shared/scores";
import type {
  AnnotationOverlayInteraction,
  AnnotationTool,
} from "../annotations/annotation-overlay";
import {
  cacheAnnotationLayers,
  cleanupUncreatedDeleteConflicts,
  discardAnnotationConflict,
  queueScoreDrafts,
  reapplyAnnotationConflict,
  retryScoreSyncErrors,
  updateCachedLayer,
} from "../annotations/local-annotations";
import { requestOutboxRecovery } from "../annotations/outbox-recovery";
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
import type { PDFDocumentProxy } from "../reader/pdf-document";
import {
  acquireReaderDocument,
  confirmReaderDocumentVersion,
  invalidateReaderDocument,
  ReaderDocumentVersionMismatchError,
} from "../reader/reader-document-cache";
import {
  forgetReaderScore,
  peekReaderScore,
  rememberReaderScore,
} from "../reader/reader-score-cache";
import { readerPdfSourceIsCurrent } from "../reader/reader-source-identity";
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

type ReaderCloudOutcome =
  | { scopeKey: string; state: "active"; versionId: string }
  | { scopeKey: string; state: "offline-allowed" };

type ReaderLoadState =
  | { kind: "resolving-workspace" }
  | { kind: "loading"; scopeKey: string }
  | { kind: "ready"; scopeKey: string }
  | { kind: "error"; scopeKey: string; message: string };

interface ReaderPdfSource {
  scopeKey: string;
  data: string | ArrayBuffer;
  kind: "cloud" | "offline";
  versionId?: string;
}

export default function ReaderPage() {
  const { choirId = "", scoreId = "" } = useParams();
  const session = authClient.useSession();
  const [resolvedWorkspace, setResolvedWorkspace] =
    useState<LocalWorkspace | null>(null);
  const [loadState, setLoadState] = useState<ReaderLoadState>({
    kind: "resolving-workspace",
  });
  const workspaceIsActive = useLiveQuery(
    () => resolvedWorkspace
      ? isLocalWorkspaceActive(resolvedWorkspace)
      : false,
    [resolvedWorkspace?.scopeKey],
    false,
  );
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const [offline, setOffline] = useState<OfflineScoreRecord | null>(null);
  const [localLookupState, setLocalLookupState] = useState<{
    scopeKey: string;
    status: "pending" | "settled";
  } | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [documentScopeKey, setDocumentScopeKey] = useState<string | null>(null);
  const [source, setSource] = useState<ReaderPdfSource | null>(null);
  const [pdfFailure, setPdfFailure] = useState<{
    source: ReaderPdfSource;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [annotationInteraction, setAnnotationInteraction] =
    useState<AnnotationOverlayInteraction>("idle");
  const [tool, setTool] = useState<AnnotationTool>("text");
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [syncOutcome, setSyncOutcome] = useState<ReaderSyncOutcome>("none");
  const [cloudState, setCloudState] = useState<
    "checking" | "active" | "trashed" | "unavailable"
  >("checking");
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
  const documentReadyScopeKey = useRef<string | null>(null);
  const cloudLookupSequence = useRef({ next: 0, applied: 0 });
  const cloudOutcome = useRef<ReaderCloudOutcome | null>(null);
  const readyDocumentSource = useRef<Pick<
    ReaderPdfSource,
    "scopeKey" | "kind" | "versionId"
  > | null>(null);
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
    }).then(async (workspace) => {
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
    workspaceIsActive &&
    resolvedWorkspace.choirId === choirId &&
    resolvedWorkspace.scoreId === scoreId
      ? resolvedWorkspace
      : null;
  const workspaceScopeKey = workspace?.scopeKey ?? null;
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
    if (!workspace) return;
    let active = true;
    const isCurrent = () => active;
    void (async () => {
      const identity = session.data?.user.id ?? "guest";
      const rememberedScore = peekReaderScore(identity, choirId, scoreId);
      const cloudSource = cloudPdfSource(
        choirId,
        scoreId,
        rememberedScore?.currentVersion.id,
      );
      setScore(rememberedScore);
      setOffline(null);
      setLocalLookupState({ scopeKey: workspace.scopeKey, status: "pending" });
      setSource({
        scopeKey: workspace.scopeKey,
        data: cloudSource,
        kind: "cloud",
        versionId: rememberedScore?.currentVersion.id,
      });
      setDocument(null);
      setDocumentScopeKey(null);
      documentReadyScopeKey.current = null;
      cloudOutcome.current = rememberedScore
        ? {
            scopeKey: workspace.scopeKey,
            state: "active",
            versionId: rememberedScore.currentVersion.id,
          }
        : null;
      readyDocumentSource.current = null;
      setPdfFailure(null);
      setEditing(false);
      setActiveLayerId(null);
      endAnnotationEditSession();
      setLoadState({ kind: "loading", scopeKey: workspace.scopeKey });
      setCloudState("checking");
      const localPromise = findActiveOfflineScore(
        workspace.ownerKey,
        choirId,
        scoreId,
      ).catch(() => undefined);
      const cloudLookupId = ++cloudLookupSequence.current.next;
      const lookupPromise = lookupScoreCloudState(choirId, scoreId);
      const localMatchesKnownCloudVersion = (local: OfflineScoreRecord) => {
        const outcome = cloudOutcome.current;
        if (outcome?.scopeKey === workspace.scopeKey) {
          return outcome.state === "offline-allowed" || outcome.versionId === local.versionId;
        }
        return rememberedScore?.currentVersion.id === local.versionId;
      };
      const localShouldTakeOver = (local: OfflineScoreRecord) => {
        if (!localMatchesKnownCloudVersion(local)) return false;
        const readySource = readyDocumentSource.current as Pick<
          ReaderPdfSource,
          "scopeKey" | "kind" | "versionId"
        > | null;
        if (
          readySource?.scopeKey === workspace.scopeKey &&
          readySource.kind === "offline" &&
          readySource.versionId === local.versionId
        ) {
          return false;
        }
        const outcome = cloudOutcome.current;
        return (
          documentReadyScopeKey.current !== workspace.scopeKey ||
          (outcome?.scopeKey === workspace.scopeKey &&
            outcome.state === "offline-allowed")
        );
      };

      void localPromise
        .then(async (local) => {
          if (!isCurrent()) return;
          setOffline(local ?? null);
          if (
            local &&
            localShouldTakeOver(local)
          ) {
            const data = await local.blob.arrayBuffer();
            if (
              isCurrent() &&
              localShouldTakeOver(local)
            ) {
              if (
                cloudOutcome.current?.scopeKey === workspace.scopeKey &&
                cloudOutcome.current.state === "offline-allowed"
              ) {
                setScore(scoreFromOffline(local));
              }
              setLoadState({ kind: "loading", scopeKey: workspace.scopeKey });
              setSource((current) => replaceSourceForScope(current, {
                scopeKey: workspace.scopeKey,
                data,
                kind: "offline",
                versionId: local.versionId,
              }));
            }
          }
          if (local) {
            await restoreOfflineAnnotationSnapshot(workspace, local).catch(() => undefined);
          }
        })
        .finally(() => {
          if (isCurrent()) {
            setLocalLookupState({ scopeKey: workspace.scopeKey, status: "settled" });
          }
        });

      const [local, lookup] = await Promise.all([localPromise, lookupPromise]);
      if (!isCurrent() || cloudLookupId < cloudLookupSequence.current.applied) return;
      if (lookup.state !== "network-unavailable") {
        cloudLookupSequence.current.applied = cloudLookupId;
      }
      cloudOutcome.current = cloudOutcomeForLookup(
        cloudOutcome.current,
        workspace.scopeKey,
        lookup,
      );
      const cloudResponseIsCurrent = () =>
        isCurrent() && cloudLookupId >= cloudLookupSequence.current.applied;
      if (lookup.state === "active") {
        rememberReaderScore(identity, lookup.score);
        setCloudState("active");
        setScore(lookup.score);
        const cloudDocumentConfirmation = confirmReaderDocumentVersion({
          ownerKey: workspace.ownerKey,
          choirId,
          scoreId,
          sourceKind: "cloud",
          versionId: lookup.score.currentVersion.id,
        });
        const readySource = readyDocumentSource.current as Pick<
          ReaderPdfSource,
          "scopeKey" | "kind" | "versionId"
        > | null;
        const matchingOfflineDocumentReady =
          local?.versionId === lookup.score.currentVersion.id &&
          readySource?.scopeKey === workspace.scopeKey &&
          readySource.kind === "offline" &&
          readySource.versionId === lookup.score.currentVersion.id;
        if (cloudDocumentConfirmation !== "match" && !matchingOfflineDocumentReady) {
          setDocument(null);
          setDocumentScopeKey(null);
          documentReadyScopeKey.current = null;
          readyDocumentSource.current = null;
          setLoadState({ kind: "loading", scopeKey: workspace.scopeKey });
          setPdfFailure(null);
          setSource((current) => replaceSourceForScope(current, {
            scopeKey: workspace.scopeKey,
            data: cloudPdfSource(
              choirId,
              scoreId,
              lookup.score.currentVersion.id,
            ),
            kind: "cloud",
            versionId: lookup.score.currentVersion.id,
          }, true));
        }
        if (
          local?.versionId === lookup.score.currentVersion.id &&
          documentReadyScopeKey.current !== workspace.scopeKey
        ) {
          const data = await local.blob.arrayBuffer();
          if (!cloudResponseIsCurrent()) return;
          setSource((current) => replaceSourceForScope(current, {
            scopeKey: workspace.scopeKey,
            data,
            kind: "offline",
            versionId: local.versionId,
          }));
        }
        return;
      }

      if (!cloudResponseIsCurrent()) return;
      if (lookup.state !== "network-unavailable") {
        forgetReaderScore(identity, choirId, scoreId);
        invalidateReaderDocument({
          ownerKey: workspace.ownerKey,
          choirId,
          scoreId,
          sourceKind: "cloud",
        });
      }
      if (lookup.state === "trashed") {
        setCloudState("trashed");
        setSyncOutcome("trash-preserved");
      } else {
        setCloudState("unavailable");
      }
      if (local && localMatchesKnownCloudVersion(local)) {
        setScore(scoreFromOffline(local));
        const data = await local.blob.arrayBuffer();
        if (!cloudResponseIsCurrent()) return;
        setSource((current) => replaceSourceForScope(current, {
          scopeKey: workspace.scopeKey,
          data,
          kind: "offline",
          versionId: local.versionId,
        }));
        return;
      }
      if (lookup.state === "network-unavailable" && rememberedScore) return;
      setLoadState({
        kind: "error",
        scopeKey: workspace.scopeKey,
        message: readerLoadFailureMessage(lookup.state),
      });
    })();
    return () => {
      active = false;
    };
  }, [choirId, scoreId, session.data?.user.id, workspace]);

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
              subscribed: previousById.get(layer.id)?.subscribed ?? layer.subscribed,
            }));
        await cacheAnnotationLayers(workspace, layersToCache);
        await syncAnnotations(workspace, { pull: true });
        if (active) setSyncOutcome("synced");
      } catch {
        if (active) setSyncOutcome("none");
      }
    })();
    return () => {
      active = false;
    };
  }, [choirId, cloudState, scoreId, session.data?.user.id, workspace]);

  useEffect(() => {
    if (!workspace) return;
    let active = true;
    const revalidateCloudState = () => {
      if (!navigator.onLine || globalThis.document.visibilityState === "hidden") return;
      const cloudLookupId = ++cloudLookupSequence.current.next;
      void lookupScoreCloudState(choirId, scoreId)
        .then(async (lookup) => {
          if (!active || cloudLookupId < cloudLookupSequence.current.applied) return;
          if (lookup.state !== "network-unavailable") {
            cloudLookupSequence.current.applied = cloudLookupId;
          }
          cloudOutcome.current = cloudOutcomeForLookup(
            cloudOutcome.current,
            workspace.scopeKey,
            lookup,
          );
          const cloudResponseIsCurrent = () =>
            active && cloudLookupId >= cloudLookupSequence.current.applied;
          if (lookup.state !== "active") {
            if (lookup.state === "network-unavailable") return;
            forgetReaderScore(session.data?.user.id ?? "guest", choirId, scoreId);
            invalidateReaderDocument({
              ownerKey: workspace.ownerKey,
              choirId,
              scoreId,
              sourceKind: "cloud",
            });
            setCloudState(lookup.state === "trashed" ? "trashed" : "unavailable");
            if (lookup.state === "trashed") setSyncOutcome("trash-preserved");
            if (offline) {
              setScore(scoreFromOffline(offline));
              const data = await offline.blob.arrayBuffer();
              if (!cloudResponseIsCurrent()) return;
              setLoadState({ kind: "loading", scopeKey: workspace.scopeKey });
              setSource((current) => replaceSourceForScope(current, {
                scopeKey: workspace.scopeKey,
                data,
                kind: "offline",
                versionId: offline.versionId,
              }));
            } else {
              setLoadState({
                kind: "error",
                scopeKey: workspace.scopeKey,
                message: readerLoadFailureMessage(lookup.state),
              });
            }
            return;
          }
          rememberReaderScore(session.data?.user.id ?? "guest", lookup.score);
          setCloudState("active");
          setScore(lookup.score);
          const cloudDocumentConfirmation = confirmReaderDocumentVersion({
            ownerKey: workspace.ownerKey,
            choirId,
            scoreId,
            sourceKind: "cloud",
            versionId: lookup.score.currentVersion.id,
          });
          const readySource = readyDocumentSource.current as Pick<
            ReaderPdfSource,
            "scopeKey" | "kind" | "versionId"
          > | null;
          const matchingOfflineDocumentReady =
            readySource?.scopeKey === workspace.scopeKey &&
            readySource.kind === "offline" &&
            readySource.versionId === lookup.score.currentVersion.id;
          if (
            cloudDocumentConfirmation !== "match" &&
            !matchingOfflineDocumentReady
          ) {
            setLoadState({ kind: "loading", scopeKey: workspace.scopeKey });
            setPdfFailure(null);
          }
          setSource((current) => {
            if (
              current?.scopeKey === workspace.scopeKey &&
              ((current.kind === "offline" &&
                current.versionId === lookup.score.currentVersion.id) ||
                (current.kind === "cloud" &&
                  cloudDocumentConfirmation === "match"))
            ) {
              return current;
            }
            return replaceSourceForScope(current, {
              scopeKey: workspace.scopeKey,
              data: cloudPdfSource(
                choirId,
                scoreId,
                lookup.score.currentVersion.id,
              ),
              kind: "cloud",
              versionId: lookup.score.currentVersion.id,
            }, cloudDocumentConfirmation !== "match");
          });
        })
        .catch(() => undefined);
    };
    window.addEventListener("online", revalidateCloudState);
    globalThis.document.addEventListener(
      "visibilitychange",
      revalidateCloudState,
    );
    return () => {
      active = false;
      window.removeEventListener("online", revalidateCloudState);
      globalThis.document.removeEventListener(
        "visibilitychange",
        revalidateCloudState,
      );
    };
  }, [choirId, offline, scoreId, session.data?.user.id, workspace]);

  useEffect(() => {
    if (!source || !workspace || source.scopeKey !== workspace.scopeKey) return;
    let active = true;
    const lease = acquireReaderDocument({
      ownerKey: workspace.ownerKey,
      choirId,
      scoreId,
      source: source.data,
      sourceKind: source.kind,
      versionId: source.versionId,
    });
    void lease.promise
      .then((nextDocument) => {
        if (active) {
          setDocument(nextDocument);
          setDocumentScopeKey(workspaceScopeKey);
          documentReadyScopeKey.current = workspaceScopeKey;
          readyDocumentSource.current = {
            scopeKey: source.scopeKey,
            kind: source.kind,
            versionId: source.versionId,
          };
          setPdfFailure(null);
          if (workspaceScopeKey) {
            setLoadState({ kind: "ready", scopeKey: workspaceScopeKey });
          }
          setCurrentPage((page) => Math.min(page, nextDocument.numPages));
        }
      })
      .catch((error) => {
        if (!active || !workspaceScopeKey) return;
        if (
          error instanceof ReaderDocumentVersionMismatchError &&
          source.kind === "cloud"
        ) {
          const expectedSource = cloudPdfSource(
            choirId,
            scoreId,
            error.expectedVersionId,
          );
          if (
            source.versionId === error.expectedVersionId &&
            source.data === expectedSource
          ) {
            setPdfFailure({
              source,
            });
            return;
          }
          setSource((current) => replaceSourceForScope(current, {
            scopeKey: workspace.scopeKey,
            data: expectedSource,
            kind: "cloud",
            versionId: error.expectedVersionId,
          }));
          return;
        }
        setPdfFailure({
          source,
        });
      });
    return () => {
      active = false;
      lease.release();
      setDocument(null);
      setDocumentScopeKey(null);
      documentReadyScopeKey.current = null;
      if (readyDocumentSource.current?.scopeKey === source.scopeKey) {
        readyDocumentSource.current = null;
      }
    };
  }, [choirId, scoreId, setCurrentPage, source, workspace, workspaceScopeKey]);

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
  }, [editing, layout, requestPage]);

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
              subscribed: currentById.get(layer.id)?.subscribed ?? layer.subscribed,
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
      if (source?.kind === "offline" && activeRecord) {
        const offlineData = await activeRecord.blob.arrayBuffer();
        setSource((current) => replaceSourceForScope(current, {
          scopeKey: workspace.scopeKey,
          data: offlineData,
          kind: "offline",
          versionId: activeRecord.versionId,
        }));
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
    setChromeVisible(false);
    setMoreOpen(false);
    setReaderPanel(null);
    setActiveLayerId(editableLayer.id);
    writeStringPreference(preferenceKey, editableLayer.id);
    setTool("text");
    beginAnnotationEditSession();
    setEditing(true);
    setSyncOutcome("local-draft");
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
      const remainingErrors = await localDatabase.annotations
        .where("[scopeKey+state]")
        .equals([workspace.scopeKey, "sync-error"])
        .count();
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
    return <p className="route-loading">正在打开本机工作区…</p>;
  }

  const loadError =
    loadState.kind === "error" &&
    loadState.scopeKey === workspace.scopeKey &&
    localLookupState?.scopeKey === workspace.scopeKey &&
    localLookupState.status === "settled"
      ? loadState.message
      : pdfFailure && readerPdfSourceIsCurrent(pdfFailure.source, source) &&
          source?.kind === "offline"
        ? "本机离线副本无法解析，现有批注仍然保留。"
      : cloudState === "active" &&
          localLookupState?.scopeKey === workspace.scopeKey &&
          localLookupState.status === "settled" &&
          pdfFailure && readerPdfSourceIsCurrent(pdfFailure.source, source)
        ? "PDF 无法解析或文件暂时不可用。"
        : cloudState === "unavailable" &&
            localLookupState?.scopeKey === workspace.scopeKey &&
            localLookupState.status === "settled" &&
            source?.kind === "cloud" &&
            pdfFailure && readerPdfSourceIsCurrent(pdfFailure.source, source)
          ? readerLoadFailureMessage("network-unavailable")
        : null;
  if (loadError) {
    return (
      <main className="page-shell compact-page">
        <p className="eyebrow">乐谱阅读器</p>
        <h1>无法打开</h1>
        <p className="hero__copy" role="alert">
          {loadError}
        </p>
        <Link className="primary-link" to={`/choirs/${choirId}`}>
          返回云盘
        </Link>
      </main>
    );
  }

  if (
    loadState.kind !== "ready" ||
    loadState.scopeKey !== workspace.scopeKey ||
    !score ||
    !document ||
    documentScopeKey !== workspace.scopeKey
  ) {
    return (
      <main className="reader-loading" aria-label="正在加载乐谱">
        <div className="reader-loading__paper" aria-hidden="true" />
        <div className="reader-loading__label" role="status">
          <strong>{score?.fileName ?? "乐谱"}</strong>
          <span>正在加载乐谱…</span>
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
            <Button
              aria-label="页面位置"
              aria-expanded={readerPanel === "pages"}
              className="reader-page-button"
              onPress={() => openReaderPanel("pages")}
            >
              {currentPage} / {document.numPages}
            </Button>
            <Button
              aria-label="图层"
              aria-expanded={readerPanel === "layers"}
              className="reader-icon-button"
              onPress={() => openReaderPanel("layers")}
            >
              <Layers aria-hidden="true" size={21} />
            </Button>
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
              {downloadMessage || syncStatus.message ? (
                <p
                  className="reader-more-menu__status"
                  data-kind={downloadMessage ? "download" : syncStatus.kind}
                  role="status"
                >
                  {downloadMessage ?? syncStatus.message}
                </p>
              ) : null}
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

      {editing ? (
        <>
          <header className="reader-edit-header">
            <div>
              <strong>{score.fileName}</strong>
              <span>编辑模式 · 第 {currentPage} 页</span>
            </div>
            {annotationInteraction !== "composing-text" ? (
              <Button onPress={() => void finishEditing()}>完成</Button>
            ) : null}
          </header>
          {annotationInteraction !== "transforming-text" ? (
            <EditingControls
              workspace={workspace}
              layers={layers}
              tool={tool}
              activeLayerId={activeLayerId}
              onToolChange={setTool}
              onLayerChange={selectEditingLayer}
            />
          ) : null}
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
      {readerPanel === "layers" ? (
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
              signedIn={Boolean(session.data?.user.id)}
            />
          </aside>
        </div>
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
    layers.filter((layer) => layer.defaultSlot !== null).map((layer) => [layer.defaultSlot, layer]),
  );
  const personalLayer = layers.find((layer) => layer.kind === "personal");

  return (
    <section className="annotation-controls" aria-label="批注工具">
      <div className="annotation-control-group" aria-label="编辑层">
        <div className="annotation-layer-switcher">
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
            slot="P"
            layer={personalLayer}
            activeLayerId={activeLayerId}
            onLayerChange={onLayerChange}
          />
        </div>
      </div>
      <div className="annotation-control-group" aria-label="工具">
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
      </div>
      <div className="annotation-control-group annotation-history-controls" aria-label="历史">
        <Button aria-label="撤销" className="annotation-tool-button"
          onPress={() => activeLayerId ? void undoAnnotationEdit(workspace, activeLayerId) : undefined}>
          <Undo2 aria-hidden="true" size={20} />
        </Button>
        <Button aria-label="重做" className="annotation-tool-button"
          onPress={() => activeLayerId ? void redoAnnotationEdit(workspace, activeLayerId) : undefined}>
          <Redo2 aria-hidden="true" size={20} />
        </Button>
      </div>
    </section>
  );
}

function LayerSlotButton({
  slot,
  layer,
  activeLayerId,
  onLayerChange,
}: {
  slot: DefaultSharedLayerSlot | "P";
  layer: AnnotationLayerSummary | undefined;
  activeLayerId: string | null;
  onLayerChange(layerId: string): void;
}) {
  const label = slot === "P" ? "P，Personal" : `${slot}，${layer?.name ?? slot}`;
  const button = (
    <Button
      aria-label={`${label}${layer?.canEdit ? "" : "，只读，查看权限说明"}`}
      aria-pressed={layer?.id === activeLayerId}
      className="annotation-layer-slot"
      onPress={() => {
        if (!layer) return;
        if (layer.canEdit) onLayerChange(layer.id);
      }}
    >
      <span>{slot}</span>
      <i aria-hidden="true" style={{ background: layer?.displayColor ?? "transparent" }} />
      {layer && !layer.canEdit ? <Lock aria-hidden="true" className="annotation-layer-slot__lock" size={11} /> : null}
    </Button>
  );
  if (!layer || layer.canEdit) return button;
  return (
    <DialogTrigger>
      {button}
      <Popover className="layer-permission-popover" offset={12} placement="top">
        <Dialog aria-label="仅可查看" className="layer-permission-dialog">
          {({ close }) => <LayerPermissionContent layer={layer} onClose={close} />}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function LayerPermissionContent({
  layer,
  onClose,
}: {
  layer: AnnotationLayerSummary;
  onClose(): void;
}) {
  return (
    <>
      <div className="layer-permission-dialog__icon"><Lock aria-hidden="true" size={20} /></div>
      <h2>仅可查看</h2>
      <p>{layer.defaultSlot} · {layer.name} 可以查看，但只有云盘管理员和被授权成员可以编辑。</p>
      <p>如需编辑权限，请联系云盘管理员。</p>
      <Button className="primary-button" onPress={onClose}>知道了</Button>
    </>
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
  signedIn,
}: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  signedIn: boolean;
}) {
  const sharedLayers = layers.filter((layer) => layer.kind === "shared");
  const personalLayer = layers.find((layer) => layer.kind === "personal");
  const overriddenLayers = sharedLayers.filter(
    (layer) => layer.scoreSubscriptionOverride !== null,
  );

  const saveScorePreference = async (
    layer: AnnotationLayerSummary,
    changes: { subscribed: boolean | null },
  ) => {
    if (!layer.defaultSlot) return;
    if (signedIn) {
      const response = await fetch(
        `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/shared-layers/${layer.defaultSlot}/preference`,
        { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) },
      );
      if (!response.ok) throw new Error("score_preference_update_failed");
    }
    const scoreSubscriptionOverride = changes.subscribed;
    await updateCachedLayer(workspace, layer.id, {
      scoreSubscriptionOverride,
      subscribed: scoreSubscriptionOverride ?? layer.driveSubscribed ?? true,
      subscriptionSource: scoreSubscriptionOverride !== null ? "score" : layer.driveSubscribed !== null ? "drive" : "product",
    });
  };

  return (
    <section className="reader-layer-panel" aria-label="图层">
      <div className="layer-section">
        <div className="layer-section__heading">
          <div><h3>共享层</h3></div>
          <div className="layer-section__actions">
            <span>{sharedLayers.filter((layer) => layer.subscribed).length} / 5</span>
            {overriddenLayers.length > 0 ? (
              <Button
                className="layer-section__restore"
                onPress={() => void Promise.all(overriddenLayers.map((layer) =>
                  saveScorePreference(layer, { subscribed: null })))}
              >
                恢复我的默认
              </Button>
            ) : null}
          </div>
        </div>
        <div className="layer-card-list">
          {sharedLayers.map((layer) => (
            <article className="layer-card" key={layer.id}>
              <div className="layer-card__main">
                <input
                  aria-label={`订阅 ${layer.defaultSlot} · ${layer.name}`}
                  checked={layer.subscribed}
                  type="checkbox"
                  onChange={(event) => void saveScorePreference(layer, { subscribed: event.target.checked })}
                />
                <span
                  aria-label={`${layer.defaultSlot} · ${layer.name} 当前颜色`}
                  className="layer-color-preview"
                  style={{ background: layer.displayColor }}
                />
                <div className="layer-card__identity">
                  <strong>
                    <span className="layer-card__slot">{layer.defaultSlot}</span>
                    <span aria-hidden="true" className="layer-card__separator">·</span>
                    {layer.name}
                  </strong>
                </div>
                {layer.scoreSubscriptionOverride !== null ? (
                  <span className="layer-card__score-override">本谱</span>
                ) : null}
                {layer.scoreSubscriptionOverride !== null ? (
                  <Button
                    aria-label={`恢复 ${layer.defaultSlot} · ${layer.name} 的云盘默认订阅`}
                    className="layer-card__restore"
                    onPress={() => void saveScorePreference(layer, { subscribed: null })}
                  >
                    恢复
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
      {personalLayer ? (
        <div className="layer-section layer-section--personal">
          <div className="layer-section__heading">
          <div><h3>个人层</h3></div>
          </div>
          <article className="layer-card">
            <div className="layer-card__main">
              <span className="layer-color-preview" style={{ background: personalLayer.displayColor }} />
              <div className="layer-card__identity">
                <strong>
                  <span className="layer-card__slot">P</span>
                  <span aria-hidden="true" className="layer-card__separator">·</span>
                  Personal
                </strong>
              </div>
            </div>
          </article>
        </div>
      ) : null}
    </section>
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

type ScoreCloudLookup =
  | { state: "active"; score: ScoreSummary }
  | { state: "trashed" }
  | { state: "missing" }
  | { state: "permission-denied" }
  | { state: "network-unavailable" };

function cloudOutcomeForLookup(
  current: ReaderCloudOutcome | null,
  scopeKey: string,
  lookup: ScoreCloudLookup,
): ReaderCloudOutcome {
  if (lookup.state === "active") {
    return {
      scopeKey,
      state: "active",
      versionId: lookup.score.currentVersion.id,
    };
  }
  if (
    lookup.state === "network-unavailable" &&
    current?.scopeKey === scopeKey &&
    current.state === "active"
  ) {
    return current;
  }
  return { scopeKey, state: "offline-allowed" };
}

async function lookupScoreCloudState(
  choirId: string,
  scoreId: string,
): Promise<ScoreCloudLookup> {
  try {
    const response = await fetch(
      `/api/choirs/${choirId}/scores/${scoreId}/bootstrap`,
    );
    if (response.status === 401 || response.status === 403) {
      return { state: "permission-denied" };
    }
    if (!response.ok) return response.status >= 500
      ? { state: "network-unavailable" }
      : { state: "missing" };
    const bootstrap = readerScoreBootstrapSchema.parse(await response.json());
    return bootstrap.state === "active"
      ? { state: "active", score: bootstrap.score }
      : { state: "trashed" };
  } catch {
    return { state: "network-unavailable" };
  }
}

function readerLoadFailureMessage(state: Exclude<ScoreCloudLookup["state"], "active">) {
  switch (state) {
    case "trashed":
      return "这份乐谱已移入回收站，当前设备没有可用的离线副本。";
    case "permission-denied":
      return "当前账号没有访问这份乐谱的权限。请返回云盘确认成员关系。";
    case "network-unavailable":
      return "网络暂时不可用，且当前设备没有这份乐谱的离线副本。";
    case "missing":
      return "这份乐谱不存在或已经被永久移除。";
  }
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

function cloudPdfSource(choirId: string, scoreId: string, versionId?: string) {
  const scorePath = `/api/choirs/${choirId}/scores/${scoreId}`;
  return versionId
    ? `${scorePath}/versions/${encodeURIComponent(versionId)}/pdf`
    : `${scorePath}/pdf`;
}

function replaceSourceForScope(
  current: ReaderPdfSource | null,
  next: ReaderPdfSource,
  force = false,
) {
  if (current && current.scopeKey !== next.scopeKey) return current;
  if (
    !force &&
    current &&
    current.kind === next.kind &&
    current.versionId === next.versionId &&
    current.data === next.data
  ) {
    return current;
  }
  return next;
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
