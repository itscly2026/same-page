import { diagnosticRequest } from "../diagnostics/diagnostics";

export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export interface UploadProgress {
  percent: number | null;
  bytesPerSecond: number;
  processing: boolean;
}

export function uploadPdf(url: string, form: FormData, signal: AbortSignal, onProgress: (progress: UploadProgress) => void) {
  return diagnosticRequest(url, { method: "POST", signal }, () => new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const started = performance.now();
    const abort = () => xhr.abort();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      xhr.upload.onprogress = null;
      xhr.upload.onload = null;
    };
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    xhr.upload.onprogress = (event) => onProgress({
      percent: event.lengthComputable && event.total > 0 ? Math.min(100, event.loaded / event.total * 100) : null,
      bytesPerSecond: event.loaded / Math.max((performance.now() - started) / 1000, 0.001),
      processing: false,
    });
    xhr.upload.onload = () => onProgress({ percent: 100, bytesPerSecond: 0, processing: true });
    xhr.onload = () => {
      cleanup();
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const index = line.indexOf(":");
        if (index > 0) headers.append(line.slice(0, index), line.slice(index + 1).trim());
      }
      if (xhr.status === 0) { reject(new TypeError("Upload failed")); return; }
      resolve(new Response([204, 205, 304].includes(xhr.status) ? null : xhr.responseText, { status: xhr.status, headers }));
    };
    xhr.onerror = () => { cleanup(); reject(new TypeError("Upload failed")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    try { xhr.open("POST", url); xhr.send(form); } catch (error) { cleanup(); reject(error); }
  }));
}
