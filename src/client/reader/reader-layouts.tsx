import { useReturnViewport } from "../navigation/use-return-viewport";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type CSSProperties,
  lazy,
  type RefObject,
  Suspense,
  type TransitionEvent as ReactTransitionEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import type {
  AnnotationOverlayInteraction,
  AnnotationInteractionHandle,
  AnnotationTool,
} from "../annotations/annotation-overlay";
import type { LocalAnnotationRecord } from "../platform/local-database";
import type { AnnotationEditor } from "../annotations/annotation-editor";
import type { PDFDocumentProxy } from "./pdf-document";
import { PdfPageCanvas, type PdfPageRenderLease } from "./pdf-page";
import {
  calculateFittedPageWidth,
  calculatePageTurnDistance,
} from "./reader-dimensions";
import type { PagedReader, PagedReaderItem } from "./use-paged-reader";
import { useReaderGestures } from "./use-reader-gestures";

const PAGE_TURN_GUTTER_PX = 14;
const AnnotationOverlay = lazy(() =>
  import("../annotations/annotation-overlay").then((module) => ({
    default: module.AnnotationOverlay,
  })),
);

import type { ToolStyle } from "../annotations/tool-style";

export interface AnnotationPageProps {
  layers: AnnotationLayerSummary[];
  annotations: LocalAnnotationRecord[];
  editing: boolean;
  tool: AnnotationTool;
  toolColor?: string;
  toolStyle?: ToolStyle;
  activeLayerId: string | null;
  onInteractionChange(interaction: AnnotationOverlayInteraction): void;
  editor: AnnotationEditor | null;
}

interface ReaderLayoutProps {
  document: PDFDocumentProxy;
  currentPage: number;
  zoom: number;
  fitRequest?: number;
  onZoomChange(value: number): void;
  onPageChange(page: number): void;
  onToggleChrome(): void;
  annotationProps: AnnotationPageProps;
}

export function PageLayout({
  document,
  currentPage,
  zoom,
  onZoomChange,
  onToggleChrome,
  annotationProps,
  pager,
}: Omit<ReaderLayoutProps, "onPageChange"> & { pager: PagedReader }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const noteInteraction = useRef<AnnotationInteractionHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previewBoundaryRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);
  useReturnViewport(containerRef, "page", size.width > 0);
  const pageRatio = usePdfPageAspectRatio(document, currentPage);
  const fitWidth = calculateFittedPageWidth(
    size.width,
    size.height,
    pageRatio,
  );
  const renderedWidth = Math.max(1, fitWidth * zoom);
  const renderedHeight = renderedWidth / pageRatio;
  const pageTurnDistance = calculatePageTurnDistance(
    renderedWidth,
    PAGE_TURN_GUTTER_PX,
  );
  const showPageWindow = !annotationProps.editing && zoom <= 1;
  const pageItems: PagedReaderItem[] = showPageWindow
    ? pager.items
    : [{ page: currentPage, position: 0 }];
  const requestPage = (target: "previous" | "next") => {
    if (zoom > 1) onZoomChange(1);
    pager.request(target);
  };
  const finishPageTransition = (event: ReactTransitionEvent<HTMLDivElement>) => {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "transform"
    ) {
      pager.finishTransition();
    }
  };
  const gestureHandlers = useReaderGestures({
    containerRef,
    contentRef,
    previewBoundaryRef,
    disabled: false,
    twoFingerOnly: annotationProps.editing,
    onNavigationStart: () => noteInteraction.current?.interrupt(),
    isObjectGestureActive: () => noteInteraction.current?.ownsObjectGesture() ?? false,
    zoom,
    onZoomChange,
    onTap: onToggleChrome,
    onEdgeTap: !annotationProps.editing && zoom <= 1 ? requestPage : undefined,
    pageTurn: !annotationProps.editing && zoom <= 1 ? pager.gesture : undefined,
    pageTurnExtent: pageTurnDistance,
  });

  return (
    <section className="page-reader" aria-label="翻页阅读">
      {pager.failedPage !== null && <aside className="reader-page-failure" role="alert">
        第 {pager.failedPage} 页显示失败，当前页已保留。
        <Button onPress={pager.retryPage}>重试翻页</Button>
      </aside>}
      <div
        className="page-reader__viewport"
        data-zoom={zoom}
        data-editing={annotationProps.editing || undefined}
        ref={containerRef}
        {...gestureHandlers}
      >
        <div
          className="page-reader__canvas-stage"
          data-underfit={zoom < 1 || undefined}
          style={{
            width: Math.max(size.width, renderedWidth),
            height: Math.max(size.height, renderedHeight),
          }}
        >
          <div
            className="page-reader__pager-window"
            ref={previewBoundaryRef}
            style={{
              width: renderedWidth,
              height: renderedHeight,
            }}
          >
            <div
              className="page-reader__pager-track"
              data-page-turn-phase={showPageWindow ? pager.phase : "disabled"}
              data-page-turn-progress={showPageWindow ? pager.progress : 0}
              onTransitionCancel={finishPageTransition}
              onTransitionEnd={finishPageTransition}
              style={{
                "--page-turn-offset": `${
                  (showPageWindow ? pager.progress : 0) * pageTurnDistance
                }px`,
              } as CSSProperties}
            >
              {pageItems.map((item) => (
                <div
                  aria-hidden={item.position === 0 ? undefined : true}
                  className="page-reader__sheet"
                  data-page-number={item.page}
                  data-page-turn-current={item.position === 0 || undefined}
                  data-page-turn-target={item.page === pager.targetPage || undefined}
                  key={pager.renderKey(item.page)}
                  style={{
                    "--page-turn-slot-offset": `${item.position * pageTurnDistance}px`,
                  } as CSSProperties}
                >
                  <div
                    className="page-reader__content page-reader__paper"
                    ref={item.position === 0 ? contentRef : undefined}
                  >
                    <AnnotatedPdfPage
                      document={document}
                      pageNumber={item.page}
                      width={renderedWidth}
                      aspectRatio={item.page === currentPage ? pageRatio : undefined}
                      annotationProps={annotationProps}
                      interactionRef={annotationProps.editing ? noteInteraction : undefined}
                      onPageRenderStart={pager.beginPageRender}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {!annotationProps.editing ? (
        <>
          <Button
            className="visually-hidden page-turn-control page-turn-control--previous"
            aria-label="上一页"
            isDisabled={currentPage <= 1}
            onPress={() => requestPage("previous")}
          >
            上一页
          </Button>
          <Button
            className="visually-hidden page-turn-control page-turn-control--next"
            aria-label="下一页"
            isDisabled={currentPage >= document.numPages}
            onPress={() => requestPage("next")}
          >
            下一页
          </Button>
        </>
      ) : null}
    </section>
  );
}

export function ContinuousLayout({
  document,
  currentPage,
  zoom,
  fitRequest = 0,
  onZoomChange,
  onPageChange,
  onToggleChrome,
  annotationProps,
}: ReaderLayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const noteInteraction = useRef<AnnotationInteractionHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const alignedPage = useRef<{ page: number; geometryReady: boolean } | null>(null);
  const size = useElementSize(scrollRef);
  const pageWidth = Math.max(1, size.width * zoom);
  const ratios = usePageAspectRatios(document);
  const geometryReady = ratios.length === document.numPages;
  const fitted = useRef({ request: 0, zoom: 1 });
  const pendingFit = useRef<{ page: number; zoom: number } | null>(null);
  useEffect(() => {
    if (!fitRequest || !geometryReady || size.width <= 0 || size.height <= 0) return;
    if (fitted.current.request === fitRequest && Math.abs(zoom - fitted.current.zoom) > 0.001) return;
    const next = calculateFittedPageWidth(size.width, size.height, ratios[currentPage - 1]) / size.width;
    if (Math.abs(next - zoom) > 0.001 || fitted.current.request !== fitRequest) {
      alignedPage.current = null;
      pendingFit.current = { page: currentPage, zoom: next };
    }
    fitted.current = { request: fitRequest, zoom: next };
    onZoomChange(next);
  }, [fitRequest, geometryReady, size.width, size.height, ratios, currentPage, zoom, onZoomChange]);
  // PDF page geometry is known independently of canvas rendering. Key the
  // virtual measurements by that geometry, so zoom never reuses old heights.
  const getItemKey = useCallback((index: number) => `${index}:${pageWidth}:${ratios[index] ?? 0.707}`, [pageWidth, ratios]);
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: document.numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => pageWidth / (ratios[index] ?? 0.707) + 8,
    getItemKey,
    overscan: 2,
    rangeExtractor: range => annotationProps.editing
      ? [...new Set([...defaultRangeExtractor(range), currentPage - 1])].sort((a, b) => a - b)
      : defaultRangeExtractor(range),
  });

  useEffect(() => {
    if (pendingFit.current) {
      if (Math.abs(zoom - pendingFit.current.zoom) > 0.001) return;
      virtualizer.scrollToIndex(pendingFit.current.page - 1, { align: "start" });
      alignedPage.current = { page: pendingFit.current.page, geometryReady };
      pendingFit.current = null;
      return;
    }
    // Initial zero-width measurements cannot establish the saved page position.
    if (size.width <= 0 || size.height <= 0 || annotationProps.editing ||
      (alignedPage.current?.page === currentPage && alignedPage.current.geometryReady === geometryReady)) return;
    // Correct estimated offsets once the real geometry has committed.
    alignedPage.current = { page: currentPage, geometryReady };
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
  }, [annotationProps.editing, currentPage, virtualizer, size.width, size.height, geometryReady, pageWidth, fitRequest, zoom]);

  useReturnViewport(scrollRef, "continuous", size.width > 0);

  const gestureHandlers = useReaderGestures({
    containerRef: scrollRef,
    contentRef,
    disabled: false,
    twoFingerOnly: annotationProps.editing,
    onNavigationStart: () => noteInteraction.current?.interrupt(),
    isObjectGestureActive: () => noteInteraction.current?.ownsObjectGesture() ?? false,
    zoom,
    onZoomChange,
    onTap: onToggleChrome,
    constrainScroll: () => {
      const element = scrollRef.current;
      if (!element || !annotationProps.editing) return;
      const page = virtualizer.getVirtualItems().find(item => item.index === currentPage - 1);
      if (page) element.scrollTop = Math.max(page.start, Math.min(element.scrollTop, Math.max(page.start, page.end - 8 - element.clientHeight)));
    },
    nativeTouchScroll: !annotationProps.editing,
    minimumZoom: Math.min(1, calculateFittedPageWidth(size.width, size.height, ratios[currentPage - 1] ?? 0.707) / Math.max(1, size.width)),
    captureAnchor: (center) => {
      const bounds = contentRef.current!.getBoundingClientRect();
      const point = { x: center.x - bounds.left, y: center.y - bounds.top };
      const page = virtualizer.getVirtualItems().find(item => item.end > point.y);
      // Page gaps remain 8px at every zoom; anchor within the actual page,
      // rather than treating the whole virtual list as one scalable image.
      const gaps = (page?.index ?? 0) * 8;
      return nextZoom => ({
        x: point.x * nextZoom / zoom,
        y: (point.y - gaps) * nextZoom / zoom + gaps,
      });
    },
  });

  return (
    <section
      className="continuous-reader"
      data-underfit={zoom < 1 || undefined}
      data-zoom={zoom}
      data-editing={annotationProps.editing || undefined}
      ref={scrollRef}
      {...gestureHandlers}
      onScroll={() => {
        // An estimated scroll event can queue an obsolete page update before
        // real geometry is aligned. Do not turn that estimate into user intent.
        if (annotationProps.editing || pendingFit.current || !geometryReady || !alignedPage.current?.geometryReady) return;
        const scrollTop = scrollRef.current?.scrollTop ?? 0;
        // Editing and preview follow the page at the viewport center.
        const threshold = scrollTop + (scrollRef.current?.clientHeight ?? 0) / 2;
        // Scroll events can precede the virtual window update; use full geometry.
        const first = virtualizer.getVirtualItemForOffset(threshold);
        if (first) {
          const page = first.index + 1;
          alignedPage.current = { page, geometryReady: true };
          onPageChange(page);
        }
      }}
      aria-label={annotationProps.editing ? "当前页编辑" : "连续滚动阅读"}
    >
      <div
        className="continuous-reader__inner"
        ref={contentRef}
        style={{
          width: Math.max(size.width, pageWidth),
          height: virtualizer.getTotalSize(),
        }}
      >
        {virtualizer.getVirtualItems().map((item) => (
          <div
            className="continuous-reader__page"
            key={item.index}
            data-index={item.index}
            data-edit-hidden={annotationProps.editing && item.index + 1 !== currentPage || undefined}
            inert={annotationProps.editing && item.index + 1 !== currentPage}
            style={{ transform: `translateY(${item.start}px)` }}
          >
            <AnnotatedPdfPage
              document={document}
              pageNumber={item.index + 1}
              width={pageWidth}
              aspectRatio={ratios[item.index] ?? 0.707}
              interactionRef={annotationProps.editing && item.index + 1 === currentPage ? noteInteraction : undefined}
              annotationProps={item.index + 1 === currentPage ? annotationProps : { ...annotationProps, editing: false }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function PageNavigatorPanel({
  document,
  currentPage,
  onSelect,
}: {
  document: PDFDocumentProxy;
  currentPage: number;
  onSelect(page: number): void;
}) {
  const [draftPage, setDraftPage] = useState<number | null>(null);
  const pendingPage = useRef(currentPage);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectRef = useRef(onSelect);
  useLayoutEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  const page = draftPage ?? currentPage;
  const panelRef = useRef<HTMLElement>(null);
  const size = useElementSize(panelRef);
  // Sample the document at a density that leaves gaps between resting thumbnails.
  // The range input still addresses every page, including those not sampled.
  const count = Math.min(document.numPages, 40, Math.max(1, Math.floor((size.width - 32) / 14) + 1));
  const activeIndex = document.numPages === 1 ? 0 : Math.round((page - 1) / (document.numPages - 1) * (count - 1));
  const thumbnails = Array.from({ length: count }, (_, index) =>
    count === 1 ? 1 : 1 + Math.round(index * (document.numPages - 1) / (count - 1)),
  );
  const clearPending = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const finish = () => {
    clearPending();
    selectRef.current(pendingPage.current);
    setDraftPage(null);
  };
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (draftPage === null) return;
    // Native range controls own dragging, including release outside the track.
    const release = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      selectRef.current(pendingPage.current);
      setDraftPage(null);
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [draftPage]);

  return (
    <>
      <output className="reader-page-indicator" aria-label="页面位置">{page} / {document.numPages}</output>
      <nav className="page-preview-strip" aria-label="页面缩略图" ref={panelRef}
        style={{ width: `${34 + (Math.min(document.numPages, 40) - 1) * 14}px` }}>
        <div className="page-preview-strip__track" aria-hidden="true">
          {thumbnails.map((number, index) => (
            <div className="page-preview-strip__thumbnail" key={index}
              data-active={index === activeIndex || undefined}
              style={{ left: `${count === 1 ? 50 : index / (count - 1) * 100}%` }}>
              <PdfPageThumbnail document={document} pageNumber={index === activeIndex ? page : number} />
            </div>
          ))}
        </div>
        <input type="range" className="page-preview-strip__slider" aria-label="跳转页码"
          min={1} max={document.numPages} step={1} value={page}
          aria-valuetext={`第 ${page} 页，共 ${document.numPages} 页`}
          disabled={document.numPages === 1}
          onChange={event => {
            const next = Number(event.target.value);
            pendingPage.current = next;
            setDraftPage(next);
            clearPending();
            // Page numbers follow the finger immediately; expensive page rendering
            // waits for a short pause and never queues intermediate destinations.
            timer.current = setTimeout(() => {
              timer.current = null;
              selectRef.current(next);
            }, 120);
          }}
          onKeyUp={() => { if (draftPage !== null) finish(); }}
          onBlur={() => { if (draftPage !== null) finish(); }}
        />
      </nav>
    </>
  );
}

function PdfPageThumbnail({
  document,
  pageNumber,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
}) {
  const aspectRatio = usePdfPageAspectRatio(document, pageNumber);
  return (
    <PdfPageCanvas
      presentation={false}
      className="pdf-thumbnail"
      document={document}
      pageNumber={pageNumber}
      width={42}
      aspectRatio={aspectRatio}
    />
  );
}

function AnnotatedPdfPage({
  document,
  pageNumber,
  width,
  aspectRatio,
  annotationProps,
  onPageRenderStart,
  interactionRef,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  aspectRatio?: number;
  annotationProps: AnnotationPageProps;
  onPageRenderStart?(page: number): PdfPageRenderLease;
  interactionRef?: RefObject<AnnotationInteractionHandle | null>;
}) {
  const resolvedAspectRatio = usePdfPageAspectRatio(
    document,
    pageNumber,
    aspectRatio,
  );
  return (
    <div
      className="annotated-pdf-page"
      style={{
        width,
        height: width / resolvedAspectRatio,
      }}
    >
      <PdfPageCanvas
        document={document}
        pageNumber={pageNumber}
        width={width}
        aspectRatio={resolvedAspectRatio}
        onRenderStart={onPageRenderStart}
      />
      <Suspense fallback={null}>
        <AnnotationOverlay
          {...annotationProps}
          interactionRef={interactionRef}
          key={`${pageNumber}:${annotationProps.editing ? `edit:${annotationProps.activeLayerId}` : "read"}`}
          pageNumber={pageNumber}
          pageAspectRatio={resolvedAspectRatio}
        />
      </Suspense>
    </div>
  );
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function usePdfPageAspectRatio(
  document: PDFDocumentProxy,
  pageNumber: number,
  knownRatio?: number,
) {
  const [ratio, setRatio] = useState(knownRatio ?? 0.707);
  useEffect(() => {
    if (knownRatio !== undefined) {
      return;
    }
    let active = true;
    void document
      .getPage(pageNumber)
      .then((page) => {
        const viewport = page.getViewport({ scale: 1 });
        if (active && viewport.height > 0) {
          setRatio(viewport.width / viewport.height);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [document, knownRatio, pageNumber]);
  return knownRatio ?? ratio;
}

function usePageAspectRatios(document: PDFDocumentProxy) {
  const [geometry, setGeometry] = useState<{ document: PDFDocumentProxy; ratios: number[] } | null>(null);
  useEffect(() => {
    let active = true;
    // Metadata only: this does not render or retain canvases for offscreen pages.
    void Promise.all(Array.from({ length: document.numPages }, async (_, index) => {
      try {
        const page = await document.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        return viewport.width / viewport.height;
      } catch { return 0.707; }
    })).then(ratios => { if (active) setGeometry({ document, ratios }); });
    return () => { active = false; };
  }, [document]);
  return geometry?.document === document ? geometry.ratios : [];
}
