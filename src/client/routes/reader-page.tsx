import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import {
  scoreListResponseSchema,
  type ScoreSummary,
} from "../../shared/scores";
import { authClient } from "../auth/auth-client";
import {
  activateVerifiedOfflineScore,
  findActiveOfflineScore,
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
      const record = {
        key: `${choirId}:${scoreId}:${score.currentVersion.id}`,
        choirId,
        scoreId,
        versionId: score.currentVersion.id,
        title: score.title,
        sha256: score.currentVersion.sha256,
        pageCount: score.currentVersion.pageCount,
        blob: new Blob([data], { type: "application/pdf" }),
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
            <span>阅读模式</span>
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
      </header>

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
        />
      ) : (
        <ContinuousLayout
          document={document}
          currentPage={currentPage}
          zoom={zoom}
          onPageChange={setCurrentPage}
        />
      )}
    </main>
  );
}

function PageLayout({ document, currentPage, zoom, onPageChange }: ReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(containerRef);
  const pointerStart = useRef<{
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  const pointerDown = (event: ReactPointerEvent) => {
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
    const start = pointerStart.current;
    const container = containerRef.current;
    if (!start || !container || zoom <= 1 || event.pointerType !== "mouse") {
      return;
    }
    container.scrollLeft = start.scrollLeft - (event.clientX - start.x);
    container.scrollTop = start.scrollTop - (event.clientY - start.y);
  };
  const pointerUp = (event: ReactPointerEvent) => {
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
          <PdfPageCanvas
            document={document}
            pageNumber={currentPage}
            width={Math.max(1, width * zoom)}
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
            <PdfPageCanvas
              document={document}
              pageNumber={item.index + 1}
              width={pageWidth}
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
}

interface ThumbnailProps {
  document: PDFDocumentProxy;
  currentPage: number;
  onSelect(page: number): void;
}
