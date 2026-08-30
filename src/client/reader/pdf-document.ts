import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function loadPdfDocument(source: string | ArrayBuffer) {
  const task = getDocument(
    typeof source === "string"
      ? {
          url: source,
          withCredentials: true,
          rangeChunkSize: 64 * 1024,
        }
      : { data: new Uint8Array(source) },
  );
  const document = await task.promise;
  return {
    document,
    destroy: () => task.destroy(),
  };
}

export type { PDFDocumentProxy };
