import { useEffect, useRef, useState } from "react";

import type { PDFDocumentProxy } from "./pdf-document";

export function PdfPageCanvas({
  document,
  pageNumber,
  width,
  aspectRatio = 0.707,
  className = "pdf-page-canvas",
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  aspectRatio?: number;
  className?: string;
}) {
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const frontCanvas = useRef(0);
  const source = useRef({ document, pageNumber });
  const [visibleCanvas, setVisibleCanvas] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const sourceChanged =
      source.current.document !== document || source.current.pageNumber !== pageNumber;
    source.current = { document, pageNumber };
    const previousFront = frontCanvas.current;
    const nextFront = 1 - previousFront;
    const canvas = canvasRefs.current[nextFront];
    if (!canvas || width <= 0) {
      return;
    }
    if (sourceChanged) {
      setVisibleCanvas(null);
    }
    let active = true;
    let cancelRender: (() => void) | undefined;

    void document
      .getPage(pageNumber)
      .then((page) => {
        if (!active) return;
        const unscaled = page.getViewport({ scale: 1 });
        const cssScale = width / unscaled.width;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: cssScale * pixelRatio });
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas is unavailable");

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const task = page.render({ canvas, canvasContext: context, viewport });
        cancelRender = () => task.cancel();
        return task.promise;
      })
      .then(() => {
        if (!active) return;
        frontCanvas.current = nextFront;
        setVisibleCanvas(nextFront);
        const previous = canvasRefs.current[previousFront];
        if (previous) {
          previous.width = 1;
          previous.height = 1;
        }
        setError(false);
      })
      .catch((reason: unknown) => {
        if (active && !(reason instanceof Error && reason.name === "RenderingCancelledException")) {
          setError(true);
        }
      });

    return () => {
      active = false;
      cancelRender?.();
    };
  }, [document, pageNumber, width]);

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
      {error ? <p role="alert">这一页暂时无法显示</p> : null}
    </div>
  );
}
