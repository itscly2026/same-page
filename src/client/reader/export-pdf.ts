import { PDFDocument, concatTransformationMatrix, popGraphicsState, pushGraphicsState } from "pdf-lib";
import type { AnnotationLayerSummary, AnnotationPayload } from "../../shared/annotations";
import type { PDFDocumentProxy } from "./pdf-document";

type ExportAnnotation = { layerId: string; payload: AnnotationPayload | null; deleted: boolean | number };

/** Preserve the original page streams. Only the annotation overlay is rasterized. */
export async function exportAnnotatedPdf(source: PDFDocumentProxy, annotations: ExportAnnotation[], layers: AnnotationLayerSummary[]) {
  const pdf = await PDFDocument.load(await source.getData());
  const colors = new Map(layers.map(layer => [layer.id, layer.displayColor]));
  for (let index = 0; index < pdf.getPageCount(); index++) {
    const objects = annotations.filter(annotation => !annotation.deleted && annotation.payload?.pageNumber === index + 1 && colors.has(annotation.layerId));
    if (!objects.length) continue;
    const original = await source.getPage(index + 1);
    const viewport = original.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    const scale = Math.min(4, 4096 / Math.max(viewport.width, viewport.height));
    canvas.width = Math.ceil(viewport.width * scale); canvas.height = Math.ceil(viewport.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法准备批注画布");
    context.scale(canvas.width / viewport.width, canvas.height / viewport.height);
    for (const object of objects) {
      const payload = object.payload!;
      context.fillStyle = context.strokeStyle = colors.get(object.layerId)!;
      if (payload.kind === "ink") {
        context.lineWidth = payload.strokeWidth * viewport.width;
        context.lineCap = context.lineJoin = "round";
        context.beginPath();
        payload.points.forEach((point, i) => {
          if (i === 0) context.moveTo(point.x * viewport.width, point.y * viewport.height);
          else context.lineTo(point.x * viewport.width, point.y * viewport.height);
        });
        context.stroke();
      } else {
        const size = payload.fontScale * viewport.width;
        context.font = `700 ${size}px system-ui, sans-serif`;
        context.textAlign = "center"; context.textBaseline = "middle";
        const lines: string[] = [];
        for (const paragraph of payload.text.split("\n")) {
          let line = "";
          for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(paragraph)) {
            if (line && context.measureText(line + segment).width > viewport.width / 2) { lines.push(line); line = ""; }
            line += segment;
          }
          lines.push(line);
        }
        lines.forEach((line, i) => context.fillText(line, payload.x * viewport.width, payload.y * viewport.height + (i - (lines.length - 1) / 2) * size * 1.25));
      }
    }
    const image = await pdf.embedPng(canvas.toDataURL("image/png"));
    // PDF.js includes CropBox, page rotation and UserUnit in this inverse.
    const bottomLeft = viewport.convertToPdfPoint(0, viewport.height);
    const bottomRight = viewport.convertToPdfPoint(viewport.width, viewport.height);
    const topLeft = viewport.convertToPdfPoint(0, 0);
    const page = pdf.getPage(index);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(
      bottomRight[0] - bottomLeft[0], bottomRight[1] - bottomLeft[1],
      topLeft[0] - bottomLeft[0], topLeft[1] - bottomLeft[1], bottomLeft[0], bottomLeft[1],
    ));
    page.drawImage(image, { x: 0, y: 0, width: 1, height: 1 });
    page.pushOperators(popGraphicsState());
    canvas.width = canvas.height = 0;
  }
  return new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" });
}
