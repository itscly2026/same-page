import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import { AnnotationOverlay, type AnnotationTool } from "../annotations/annotation-overlay";
import type { LocalAnnotationRecord } from "../platform/local-database";
import type { PDFDocumentProxy } from "./pdf-document";
import { PdfPageCanvas } from "./pdf-page";
import { calculateFittedPageWidth } from "./reader-dimensions";
import { useReaderGestures } from "./use-reader-gestures";

export interface AnnotationPageProps {
  choirId: string;
  scoreId: string;
  layers: AnnotationLayerSummary[];
  annotations: LocalAnnotationRecord[];
  editing: boolean;
  tool: AnnotationTool;
  activeLayerId: string | null;
}

export interface ContinuousReaderPosition {
  page: number;
  pageOffsetRatio: number;
}

interface ReaderLayoutProps {
  document: PDFDocumentProxy;
  currentPage: number;
  zoom: number;
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
  onPageChange,
  onToggleChrome,
  annotationProps,
}: ReaderLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);
  const pageRatio = usePdfPageAspectRatio(document, currentPage);
  const fitWidth = calculateFittedPageWidth(
    size.width,
    size.height,
    pageRatio,
  );
  const renderedWidth = Math.max(1, fitWidth * zoom);
  const renderedHeight = renderedWidth / pageRatio;
  const gestureHandlers = useReaderGestures({
    containerRef,
    disabled: annotationProps.editing,
    zoom,
    onZoomChange,
    onTap: onToggleChrome,
    onEdgeTap: (direction) => {
      const targetPage =
        direction === "next"
          ? Math.min(document.numPages, currentPage + 1)
          : Math.max(1, currentPage - 1);
      if (targetPage !== currentPage) onPageChange(targetPage);
    },
    onSwipe: (direction) =>
      onPageChange(
        direction === "next"
          ? Math.min(document.numPages, currentPage + 1)
          : Math.max(1, currentPage - 1),
      ),
  });

  return (
    <section className="page-reader" aria-label="翻页阅读">
      <div
        className="page-reader__viewport"
        data-zoom={zoom}
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
          <AnnotatedPdfPage
            document={document}
            pageNumber={currentPage}
            width={renderedWidth}
            annotationProps={annotationProps}
          />
        </div>
      </div>
      {!annotationProps.editing ? (
        <>
          <Button
            className="visually-hidden page-turn-control page-turn-control--previous"
            aria-label="上一页"
            isDisabled={currentPage <= 1}
            onPress={() => onPageChange(Math.max(1, currentPage - 1))}
          >
            上一页
          </Button>
          <Button
            className="visually-hidden page-turn-control page-turn-control--next"
            aria-label="下一页"
            isDisabled={currentPage >= document.numPages}
            onPress={() =>
              onPageChange(Math.min(document.numPages, currentPage + 1))
            }
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
  onZoomChange,
  onPageChange,
  onToggleChrome,
  annotationProps,
  restorePosition,
  onPositionChange,
  onRestoreComplete,
}: ReaderLayoutProps & {
  restorePosition: ContinuousReaderPosition | null;
  onPositionChange(position: ContinuousReaderPosition): void;
  onRestoreComplete(): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const skipNextPageAlignment = useRef(false);
  const size = useElementSize(scrollRef);
  const pageWidth = Math.max(1, size.width * zoom);
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: document.numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => pageWidth * 1.35 + 8,
    overscan: 2,
  });

  useEffect(() => {
    if (restorePosition !== null) return;
    if (skipNextPageAlignment.current) {
      skipNextPageAlignment.current = false;
      return;
    }
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
  }, [currentPage, restorePosition, virtualizer]);

  useEffect(() => {
    if (restorePosition === null) return;
    let positionFrame = 0;
    const pageFrame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(restorePosition.page - 1, { align: "start" });
      positionFrame = requestAnimationFrame(() => {
        const scrollElement = scrollRef.current;
        if (!scrollElement) return;
        const target = virtualizer
          .getVirtualItems()
          .find((item) => item.index === restorePosition.page - 1);
        if (target) {
          scrollElement.scrollTop =
            target.start + target.size * restorePosition.pageOffsetRatio;
        }
        onPositionChange(restorePosition);
        skipNextPageAlignment.current = true;
        onRestoreComplete();
      });
    });
    return () => {
      cancelAnimationFrame(pageFrame);
      cancelAnimationFrame(positionFrame);
    };
  }, [onPositionChange, onRestoreComplete, restorePosition, virtualizer]);

  const gestureHandlers = useReaderGestures({
    containerRef: scrollRef,
    disabled: annotationProps.editing,
    zoom,
    onZoomChange,
    onTap: onToggleChrome,
    panAtFit: true,
  });

  return (
    <section
      className="continuous-reader"
      data-underfit={zoom < 1 || undefined}
      data-zoom={zoom}
      ref={scrollRef}
      {...gestureHandlers}
      onScroll={() => {
        const scrollTop = scrollRef.current?.scrollTop ?? 0;
        const threshold = scrollTop + 8;
        const items = virtualizer.getVirtualItems();
        const first = items.find((item) => item.end > threshold) ?? items[0];
        if (first) {
          const page = first.index + 1;
          onPositionChange({
            page,
            pageOffsetRatio: clamp((scrollTop - first.start) / first.size, 0, 1),
          });
          onPageChange(page);
        }
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

export function PageNavigatorPanel({
  document,
  currentPage,
  onSelect,
}: {
  document: PDFDocumentProxy;
  currentPage: number;
  onSelect(page: number): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: document.numPages,
    getScrollElement: () => panelRef.current,
    estimateSize: () => 64,
    horizontal: true,
    overscan: 5,
  });

  useEffect(() => {
    virtualizer.scrollToIndex(currentPage - 1, { align: "auto" });
  }, [currentPage, virtualizer]);

  return (
    <nav className="page-preview-strip" aria-label="页面缩略图">
      <output className="page-preview-strip__position" aria-live="polite">
        {currentPage} / {document.numPages}
      </output>
      <div className="page-preview-strip__track" ref={panelRef}>
        <div
          className="page-preview-strip__inner"
          style={{ width: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <button
              className="page-preview-strip__button"
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
                width={42}
              />
              <span>{item.index + 1}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
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
        key={`${pageNumber}:${annotationProps.editing ? `edit:${annotationProps.activeLayerId}:${annotationProps.tool}` : "read"}`}
        pageNumber={pageNumber}
      />
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
) {
  const [ratio, setRatio] = useState(0.707);
  useEffect(() => {
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
  }, [document, pageNumber]);
  return ratio;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
