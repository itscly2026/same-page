import { diagnosticFetch } from "../diagnostics/diagnostics";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function preloadPdfWorkerAsset(target: Document = document) {
  if (target.head.querySelector("link[data-same-page-pdf-worker]")) return;
  const preload = target.createElement("link");
  preload.rel = "modulepreload";
  preload.href = pdfWorkerUrl;
  preload.dataset.samePagePdfWorker = "true";
  target.head.append(preload);
}

export interface PdfDocumentLoad {
  promise: Promise<{
    document: PDFDocumentProxy;
    versionId: string | null;
  }>;
  destroy(): Promise<void>;
}

export function loadPdfDocument(
  source: string | ArrayBuffer,
  expectedVersionId?: string,
): PdfDocumentLoad {
  const abortController = new AbortController();
  let destroyed = false;
  let loadingTask: ReturnType<typeof getDocument> | null = null;
  const promise = (async () => {
    let resolvedSource = source;
    let actualVersionId = expectedVersionId ?? null;
    if (typeof source === "string" && !expectedVersionId) {
      const response = await diagnosticFetch(source, {
        method: "HEAD",
        credentials: "include",
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`pdf_head_${response.status}`);
      actualVersionId = response.headers.get("X-Score-Version");
      if (!actualVersionId) throw new Error("pdf_version_header_missing");
      resolvedSource = versionedPdfUrl(source, actualVersionId);
    }
    if (destroyed) throw new DOMException("PDF load cancelled", "AbortError");
    loadingTask = getDocument(
      typeof resolvedSource === "string"
        ? {
            url: resolvedSource,
            withCredentials: true,
            rangeChunkSize: 64 * 1024,
          }
        : { data: new Uint8Array(resolvedSource) },
    );
    const document = await loadingTask.promise;
    return { document, versionId: actualVersionId };
  })();
  return {
    promise,
    destroy: async () => {
      destroyed = true;
      abortController.abort();
      await loadingTask?.destroy();
    },
  };
}

function versionedPdfUrl(currentUrl: string, versionId: string) {
  const suffix = "/pdf";
  if (!currentUrl.endsWith(suffix)) throw new Error("invalid_current_pdf_url");
  return `${currentUrl.slice(0, -suffix.length)}/versions/${encodeURIComponent(versionId)}/pdf`;
}

export type { PDFDocumentProxy };
