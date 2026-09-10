import { pdfFailureCategory, pdfFailureReason, pdfEngineVersion, recordFailure } from "../diagnostics/diagnostics";
import { acquireRenderSlot, sizeRenderCanvas, releaseRenderCanvas } from "./render-budget";
import { usePagePresentation } from "./use-reader-presentation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PDFDocumentProxy } from "./pdf-document";
import { completeLoadingJourney } from "../performance/loading-performance";

export function PdfPageCanvas({
  document,
  pageNumber,
  width,
  aspectRatio = 0.707,
  className = "pdf-page-canvas",
  onRenderStart,
  presentation = true,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  aspectRatio?: number;
  className?: string;
  onRenderStart?(pageNumber: number): PdfPageRenderLease;
  presentation?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const frontCanvas = useRef(0);
  const source = useRef({ document, pageNumber });
  const renderLease = useRef<PdfPageRenderLease | null>(null);
  const [painted, setPainted] = useState<{ canvas: number; document: PDFDocumentProxy; pageNumber: number } | null>(null);
  const visibleCanvas = painted?.canvas ?? null;
  const [error, setError] = useState(false);

  const reportFailure = usePagePresentation(document, pageNumber, painted, error, presentation);

  useLayoutEffect(() => {
    const lease = onRenderStart?.(pageNumber) ?? null;
    renderLease.current = lease;
    return () => {
      if (renderLease.current === lease) renderLease.current = null;
      lease?.cancel();
    };
  }, [document, onRenderStart, pageNumber, width]);

  useLayoutEffect(() => {
    if (visibleCanvas === null) return;
    const previous = canvasRefs.current[1 - visibleCanvas];
    if (!previous) return;
    releaseRenderCanvas(previous);
  }, [visibleCanvas]);

  useLayoutEffect(() => { const canvases = [...canvasRefs.current]; return () => { canvases.forEach(canvas => { if (canvas) releaseRenderCanvas(canvas); }); }; }, []);

  useEffect(() => {
    const sourceChanged =
      source.current.pageNumber !== pageNumber;
    source.current = { document, pageNumber };
    const previousFront = frontCanvas.current;
    const nextFront = 1 - previousFront;
    const canvas = canvasRefs.current[nextFront];
    if (!canvas || width <= 0) {
      return;
    }
    if (sourceChanged) {
      setPainted(null);
    }
    let active = true;
    let cancelRender: (() => void) | undefined;
    const lease = renderLease.current;

    const abort = new AbortController();
    const draw = async () => {
      const release = await acquireRenderSlot(abort.signal);
      try {
        for (let resolution = 1; resolution >= 0.5; resolution /= 2) {
          let drawing = true;
          let onAbort: (() => void) | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                const page = await document.getPage(pageNumber);
                abort.signal.throwIfAborted();
                if (!drawing) throw new DOMException("cancelled", "AbortError");
                const unscaled = page.getViewport({ scale: 1 });
                const pixels = width * Math.min(window.devicePixelRatio || 1, 2) * resolution;
                sizeRenderCanvas(canvas, pixels, pixels * unscaled.height / unscaled.width);
                const context = canvas.getContext("2d", { alpha: false });
                if (!context) throw new Error("canvas_unavailable");
                const viewport = page.getViewport({ scale: canvas.width / unscaled.width });
                const task = page.render({ canvas, canvasContext: context, viewport });
                cancelRender = () => task.cancel();
                return task.promise;
              })(),
              new Promise<never>((_, reject) => {
                onAbort = () => reject(abort.signal.reason);
                abort.signal.addEventListener("abort", onAbort, { once: true });
                timer = setTimeout(() => reject(Object.assign(new Error("page_render_timeout"), { name: "TimeoutError" })), 20_000);
              }),
            ]);
            return;
          } catch (error) {
            cancelRender?.();
            if (abort.signal.aborted || resolution === 0.5 || (error instanceof Error && error.name === "TimeoutError")) throw error;
          } finally { drawing = false; if (onAbort) abort.signal.removeEventListener("abort", onAbort); if (timer) clearTimeout(timer); }
        }
      } finally { release(); }
    };
    void draw()
      .then(() => {
        if (!active) return;
        frontCanvas.current = nextFront;
        setPainted({ canvas: nextFront, document, pageNumber });
        setError(false);
        lease?.ready();
        window.requestAnimationFrame(() => {
          completeLoadingJourney("open-score", "first-canvas-visible");
        });
      })
      .catch((reason: unknown) => {
        if (active && !(reason instanceof Error && reason.name === "RenderingCancelledException")) {
          recordFailure({ operation: "pdf", category: pdfFailureCategory(reason), stage: "decode", pdfReason: pdfFailureReason(reason, true), engineVersion: pdfEngineVersion });
          setError(true);
          reportFailure(reason instanceof Error && reason.name === "Error" && pdfFailureCategory(reason) === "internal" ? Object.assign(new Error("pdf_page_render_failed"), { name: "PdfPageRenderError" }) : reason);
          lease?.failed?.();
        }
      });

    return () => {
      active = false;
      abort.abort();
      cancelRender?.();
    };
  }, [document, onRenderStart, pageNumber, width, attempt, reportFailure]);

  return (
    <div
      className={`${className}${error ? " pdf-page-canvas--error" : ""}`}
      data-page-number={pageNumber}
      role={error ? undefined : "img"}
      aria-label={error ? undefined : `第 ${pageNumber} 页`}
      style={{
        width: `${Math.max(1, width)}px`,
        height: `${Math.max(1, width / Math.max(0.001, aspectRatio))}px`,
      }}
    >
      {[0, 1].map((index) => (
        <canvas
          aria-hidden="true"
          data-pdf-canvas-active={index === visibleCanvas ? "" : undefined}
          hidden={index !== visibleCanvas}
          key={index}
          ref={(node) => {
            canvasRefs.current[index] = node;
          }}
        />
      ))}
      {error ? <div className="page-render-recovery"><p role="alert">这一页暂时无法显示</p><button onClick={() => setAttempt(value => value + 1)}>重试本页</button></div> : null}
    </div>
  );
}

export interface PdfPageRenderLease {
  ready(): void;
  failed?(): void;
  cancel(): void;
}
