import { imageManifestSchema, pageImagePath, scoreImagesPath, type ImageManifest } from "../../shared/score-images";
import { sha256Hex } from "../offline/offline-score-verification";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import type { LocalWorkspace } from "../platform/local-workspace";
import type { PDFDocumentProxy } from "./pdf-document";

export type ScoreDocument = PDFDocumentProxy | ImageDocument;
export class ImageDocument {
  readonly kind = "images";
  readonly numPages: number;
  constructor(readonly manifest: ImageManifest, private base: string, private bundle?: Blob) {
    this.numPages = manifest.pages.length;
  }
  async getPage(number: number) {
    const page = this.manifest.pages[number - 1];
    if (!page) throw new Error("image_page_missing");
    return {
      kind: "image" as const,
      getViewport: ({ scale }: { scale: number }) => ({ width: page.width * scale, height: page.height * scale }),
      paint: async (canvas: HTMLCanvasElement, signal: AbortSignal) => {
        const edge = !this.bundle && Math.max(canvas.width, canvas.height) > 2048 ? 3072 : 2048;
        const asset = page.assets.find(a => a.edge === edge)!;
        let blob: Blob;
        if (this.bundle) {
          const offset = this.manifest.pages.slice(0, number - 1).reduce((sum, p) => sum + p.assets[0].sizeBytes, 0);
          blob = this.bundle.slice(offset, offset + asset.sizeBytes, "image/png");
        } else {
          const response = await diagnosticFetch(pageImagePath(this.base, this.manifest, number, edge), { signal });
          if (!response.ok) throw Object.assign(new Error("image_download_failed"), { status: response.status });
          blob = await response.blob();
        }
        signal.throwIfAborted();
        const bytes = await blob.arrayBuffer();
        if (bytes.byteLength !== asset.sizeBytes || await sha256Hex(bytes) !== asset.sha256) throw new Error("image_checksum_mismatch");
        const header = new DataView(bytes);
        if (bytes.byteLength < 24 || header.getUint32(0) !== 0x89504e47 || header.getUint32(16) !== asset.width || header.getUint32(20) !== asset.height) throw new Error("image_header_mismatch");
        const url = URL.createObjectURL(blob), image = new Image();
        try {
          let rejectLoad: (reason?: unknown) => void = () => {};
          const loaded = new Promise<void>((resolve, reject) => {
            rejectLoad = reject;
            image.onload = () => resolve(); image.onerror = () => reject(new Error("image_decode_failed"));
          });
          const cancel = () => { image.src = ""; rejectLoad(signal.reason); };
          signal.addEventListener("abort", cancel, { once: true });
          try { image.src = url; await loaded; }
          finally { signal.removeEventListener("abort", cancel); }
          signal.throwIfAborted();
          if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) throw new Error("image_dimensions_mismatch");
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("canvas_unavailable");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
        } finally { image.src = ""; URL.revokeObjectURL(url); }
      },
    };
  }
}
export async function prepareImageManifest(workspace: LocalWorkspace, versionId: string, sourceSha256: string, signal: AbortSignal) {
  const base = scoreImagesPath(workspace.choirId, workspace.scoreId, versionId);
  let requested = false;
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    signal.throwIfAborted();
    const response = await diagnosticFetch(base, { signal });
    if (!response.ok) throw Object.assign(new Error("image_manifest_unavailable"), { status: response.status });
    const body = await response.json() as { state: string; manifest?: unknown };
    if (body.state === "ready") {
      const manifest = imageManifestSchema.parse(body.manifest);
      if (manifest.versionId !== versionId || manifest.sourceSha256 !== sourceSha256) throw new Error("image_version_mismatch");
      return manifest;
    }
    if (body.state === "failed" && requested) throw new Error("image_conversion_failed");
    if (!requested && (body.state === "absent" || body.state === "failed")) {
      const preparation = await diagnosticFetch(base, { method: "POST", signal });
      if (!preparation.ok) throw Object.assign(new Error("image_preparation_failed"), { status: preparation.status });
      requested = true;
    }
    if (!["absent", "preparing", "failed"].includes(body.state)) throw new Error("image_state_invalid");
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 1500);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  throw new Error("image_preparation_timeout");
}
