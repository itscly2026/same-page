import type { AnnotationPayload } from "../../shared/annotations";

/** Measure the same CSS as the reader, including word boundaries and explicit newlines. */
export function paintExportText(context: CanvasRenderingContext2D, payload: Extract<AnnotationPayload, { kind: "text" }>, width: number, height: number) {
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;container-type:inline-size;visibility:hidden;pointer-events:none`;
  const text = document.createElement("button");
  text.className = "annotation-text";
  text.disabled = true;
  text.style.left = `${payload.x * 100}%`; text.style.top = `${payload.y * 100}%`;
  text.style.fontSize = `${payload.fontScale * 100}cqw`;
  text.style.textAlign = payload.textAlign ?? "center";
  const node = document.createTextNode(payload.text);
  text.append(node); container.append(text); document.body.append(container);
  try {
    const style = getComputedStyle(text);
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.textAlign = "left"; context.textBaseline = "alphabetic";
    const origin = container.getBoundingClientRect();
    const lines: { top: number; left: number; value: string }[] = [];
    const range = document.createRange();
    for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(payload.text)) {
      if (segment === "\n") continue;
      range.setStart(node, index); range.setEnd(node, index + segment.length);
      const box = range.getBoundingClientRect();
      const line = lines.at(-1);
      if (line && Math.abs(line.top - box.top) < .5) { line.value += segment; line.left = Math.min(line.left, box.left); }
      else lines.push({ top: box.top, left: box.left, value: segment });
    }
    for (const line of lines) {
      const metrics = context.measureText(line.value);
      context.fillText(line.value, line.left - origin.left, line.top - origin.top + metrics.fontBoundingBoxAscent);
    }
  } finally { container.remove(); }
}
