import { useEffect, useRef, useState } from "react";

import type { PDFDocumentProxy } from "./pdf-document";

export function PdfPageCanvas({
  document,
  pageNumber,
  width,
  className = "pdf-page-canvas",
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) {
      return;
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
        canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
        const task = page.render({ canvas, canvasContext: context, viewport });
        cancelRender = () => task.cancel();
        return task.promise;
      })
      .then(() => {
        if (active) setError(false);
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
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`第 ${pageNumber} 页`}
      />
      {error ? <p role="alert">这一页暂时无法显示</p> : null}
    </div>
  );
}
