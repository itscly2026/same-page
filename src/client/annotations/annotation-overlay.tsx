import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { Trash2 } from "lucide-react";

import type {
  AnnotationLayerSummary,
  AnnotationPayload,
} from "../../shared/annotations";
import type { LocalAnnotationRecord } from "../platform/local-database";
import type { LocalWorkspace } from "../platform/local-workspace";
import {
  saveDraftWithHistory,
  updateLatestHistoryDraft,
} from "./edit-history";

export type AnnotationTool = "text" | "ink" | "eraser";

type TextPayload = Extract<AnnotationPayload, { kind: "text" }>;

const ERASER_HIT_RADIUS_PX = 14;
const TEXT_DRAG_THRESHOLD = 0.006;

export function AnnotationOverlay({
  workspace,
  pageNumber,
  layers,
  annotations,
  editing,
  tool,
  activeLayerId,
}: {
  workspace: LocalWorkspace;
  pageNumber: number;
  layers: AnnotationLayerSummary[];
  annotations: LocalAnnotationRecord[];
  editing: boolean;
  tool: AnnotationTool;
  activeLayerId: string | null;
}) {
  const [draftStroke, setDraftStroke] = useState<Extract<AnnotationPayload, { kind: "ink" }> | null>(null);
  const [textEditor, setTextEditor] = useState<{
    id: string;
    x: number;
    y: number;
    initial: string;
  } | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const suppressTextBlur = useRef(false);
  const currentStrokeId = useRef<string | null>(null);
  const strokeHistoryStarted = useRef(false);
  const eraserPointerId = useRef<number | null>(null);
  const erasedStrokeIds = useRef(new Set<string>());
  const dragText = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    payload: TextPayload;
    moved: boolean;
  } | null>(null);
  const [textDragPreview, setTextDragPreview] = useState<{
    id: string;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const visibleLayerIds = new Set(
    layers
      .filter((layer) =>
        editing ? layer.id === activeLayerId : layer.visible,
      )
      .map((layer) => layer.id),
  );
  const layerColors = new Map(
    layers.map((layer) => [layer.id, layer.colorOverride ?? layer.defaultColor]),
  );
  const pageAnnotations = annotations.filter(
    (annotation) =>
      annotation.payload?.pageNumber === pageNumber &&
      visibleLayerIds.has(annotation.layerId),
  );

  const point = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
      ...(event.pressure > 0 ? { pressure: event.pressure } : {}),
    };
  };

  const eraseAt = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!activeLayerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointer = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
    for (const annotation of pageAnnotations) {
      const payload = annotation.payload;
      if (
        annotation.layerId !== activeLayerId ||
        payload?.kind !== "ink" ||
        erasedStrokeIds.current.has(annotation.id)
      ) {
        continue;
      }
      const points = payload.points.map((entry) => ({
        x: entry.x * bounds.width,
        y: entry.y * bounds.height,
      }));
      if (distanceToPolyline(pointer, points) > ERASER_HIT_RADIUS_PX) continue;
      erasedStrokeIds.current.add(annotation.id);
      void saveDraftWithHistory(workspace, {
        id: annotation.id,
        layerId: annotation.layerId,
        payload: null,
        deleted: true,
      }).catch(() => erasedStrokeIds.current.delete(annotation.id));
    }
  };

  const openTextEditor = (editor: NonNullable<typeof textEditor>) => {
    const input = textInputRef.current;
    if (input) input.value = editor.initial;
    setTextEditor(editor);
    // WebKit only opens the software keyboard when focus happens directly in
    // the user gesture call stack. Keep this input mounted between edits so we
    // do not have to rely on a later autoFocus render.
    input?.focus({ preventScroll: true });
  };

  const closeTextEditor = (blur = true) => {
    setTextEditor(null);
    const input = textInputRef.current;
    if (blur && input && input === document.activeElement) {
      suppressTextBlur.current = true;
      input.blur();
    }
  };

  const finishTextEditor = async (blur = true) => {
    if (!textEditor || !activeLayerId) return;
    const editor = textEditor;
    const layerId = activeLayerId;
    const text = textInputRef.current?.value.trim() ?? "";
    closeTextEditor(blur);
    if (text) {
      await saveDraftWithHistory(workspace, {
        id: editor.id,
        layerId,
        payload: {
          kind: "text",
          pageNumber,
          x: editor.x,
          y: editor.y,
          text,
        },
      });
    }
  };

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!editing || !activeLayerId) return;
    const position = point(event);
    if (tool === "text") {
      if (textEditor) {
        void finishTextEditor();
        return;
      }
      openTextEditor({
        id: crypto.randomUUID(),
        x: position.x,
        y: position.y,
        initial: "",
      });
      return;
    }
    if (tool === "eraser") {
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      eraserPointerId.current = event.pointerId;
      erasedStrokeIds.current.clear();
      eraseAt(event);
      return;
    }
    if (tool !== "ink") return;
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    currentStrokeId.current = crypto.randomUUID();
    strokeHistoryStarted.current = false;
    setDraftStroke({
      kind: "ink",
      pageNumber,
      points: [position, position],
      strokeWidth: 0.003,
    });
  };

  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      editing &&
      tool === "eraser" &&
      eraserPointerId.current === event.pointerId
    ) {
      eraseAt(event);
      return;
    }
    if (!editing || tool !== "ink" || !currentStrokeId.current || !activeLayerId) return;
    const position = point(event);
    setDraftStroke((current) => {
      if (!current) return current;
      const next = { ...current, points: [...current.points, position] };
      const input = {
        id: currentStrokeId.current!,
        layerId: activeLayerId,
        payload: next,
      };
      if (strokeHistoryStarted.current) {
        void updateLatestHistoryDraft(workspace, input);
      } else {
        strokeHistoryStarted.current = true;
        void saveDraftWithHistory(workspace, input);
      }
      return next;
    });
  };

  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (
      eraserPointerId.current === event.pointerId ||
      currentStrokeId.current !== null
    ) {
      if (
        typeof event.currentTarget.hasPointerCapture === "function" &&
        event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
    setDraftStroke(null);
    currentStrokeId.current = null;
    strokeHistoryStarted.current = false;
    eraserPointerId.current = null;
    erasedStrokeIds.current.clear();
  };

  return (
    <div
      className="annotation-overlay"
      data-editing={editing || undefined}
      data-tool={editing ? tool : undefined}
    >
      <svg
        aria-label={`第 ${pageNumber} 页批注层`}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        {pageAnnotations.map((annotation) => {
          const payload = annotation.payload;
          const color = layerColors.get(annotation.layerId) ?? "#a12652";
          if (payload?.kind === "ink") {
            return (
              <g key={annotation.id}>
                {editing &&
                tool === "eraser" &&
                annotation.layerId === activeLayerId ? (
                  <polyline
                    aria-hidden="true"
                    data-eraser-hit-target
                    points={payload.points.map((entry) => `${entry.x * 1000},${entry.y * 1000}`).join(" ")}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={ERASER_HIT_RADIUS_PX * 2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null}
                <polyline
                  points={payload.points.map((entry) => `${entry.x * 1000},${entry.y * 1000}`).join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth={payload.strokeWidth * 1000}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          }
          return null;
        })}
        {editing && draftStroke ? (
          <polyline
            points={draftStroke.points.map((entry) => `${entry.x * 1000},${entry.y * 1000}`).join(" ")}
            fill="none"
            stroke={layerColors.get(activeLayerId ?? "") ?? "#a12652"}
            strokeWidth={draftStroke.strokeWidth * 1000}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {pageAnnotations.map((annotation) => {
        const payload = annotation.payload;
        if (payload?.kind !== "text") return null;
        const position =
          textDragPreview?.id === annotation.id &&
          textDragPreview.originX === payload.x &&
          textDragPreview.originY === payload.y
            ? textDragPreview
            : payload;
        return (
          <button
            className="annotation-text"
            style={{
              left: `${position.x * 100}%`,
              top: `${position.y * 100}%`,
              color: layerColors.get(annotation.layerId) ?? "#a12652",
            }}
            key={annotation.id}
            disabled={!editing || annotation.layerId !== activeLayerId}
            onPointerDown={(event) => {
              if (!editing || annotation.layerId !== activeLayerId || tool !== "text") return;
              if (textEditor) {
                void finishTextEditor();
                return;
              }
              dragText.current = {
                id: annotation.id,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                payload,
                moved: false,
              };
              setTextDragPreview(null);
              if (typeof event.currentTarget.setPointerCapture === "function") {
                event.currentTarget.setPointerCapture(event.pointerId);
              }
            }}
            onPointerMove={(event) => {
              const drag = dragText.current;
              if (!drag || drag.pointerId !== event.pointerId || tool !== "text") return;
              const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
              const dx = (event.clientX - drag.startX) / bounds.width;
              const dy = (event.clientY - drag.startY) / bounds.height;
              if (!drag.moved && Math.hypot(dx, dy) <= TEXT_DRAG_THRESHOLD) return;
              drag.moved = true;
              setTextDragPreview({
                id: drag.id,
                x: clamp(drag.payload.x + dx),
                y: clamp(drag.payload.y + dy),
                originX: drag.payload.x,
                originY: drag.payload.y,
              });
            }}
            onPointerUp={(event) => {
              const drag = dragText.current;
              dragText.current = null;
              if (!drag || drag.pointerId !== event.pointerId || tool !== "text") {
                setTextDragPreview(null);
                return;
              }
              if (
                typeof event.currentTarget.hasPointerCapture === "function" &&
                event.currentTarget.hasPointerCapture(event.pointerId)
              ) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
              const dx = (event.clientX - drag.startX) / bounds.width;
              const dy = (event.clientY - drag.startY) / bounds.height;
              if (drag.moved) {
                const finalPosition = {
                  id: drag.id,
                  x: clamp(drag.payload.x + dx),
                  y: clamp(drag.payload.y + dy),
                  originX: drag.payload.x,
                  originY: drag.payload.y,
                };
                setTextDragPreview(finalPosition);
                void saveDraftWithHistory(workspace, {
                  id: annotation.id,
                  layerId: annotation.layerId,
                  payload: {
                    ...drag.payload,
                    x: finalPosition.x,
                    y: finalPosition.y,
                  },
                });
              } else {
                setTextDragPreview(null);
                openTextEditor({
                  id: annotation.id,
                  x: payload.x,
                  y: payload.y,
                  initial: payload.text,
                });
              }
            }}
            onPointerCancel={(event) => {
              if (dragText.current?.pointerId !== event.pointerId) return;
              dragText.current = null;
              setTextDragPreview(null);
              if (
                typeof event.currentTarget.hasPointerCapture === "function" &&
                event.currentTarget.hasPointerCapture(event.pointerId)
              ) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Delete" || event.key === "Backspace") {
                void saveDraftWithHistory(workspace, {
                  id: annotation.id,
                  layerId: annotation.layerId,
                  payload: null,
                  deleted: true,
                });
              }
            }}
          >
            {payload.text}
          </button>
        );
      })}
      {editing && tool === "text" ? (
        <form
          className="annotation-text-editor"
          data-active={textEditor ? "true" : undefined}
          style={
            textEditor
              ? { left: `${textEditor.x * 100}%`, top: `${textEditor.y * 100}%` }
              : undefined
          }
          onSubmit={(event) => {
            event.preventDefault();
            void finishTextEditor();
          }}
        >
          <input
            aria-label={textEditor ? "批注文本" : undefined}
            name="text"
            ref={textInputRef}
            tabIndex={textEditor ? 0 : -1}
            inputMode="text"
            enterKeyHint="done"
            maxLength={1000}
            onBlur={() => {
              if (suppressTextBlur.current) {
                suppressTextBlur.current = false;
                return;
              }
              void finishTextEditor(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeTextEditor();
              } else if (event.key === "Enter") {
                event.preventDefault();
                void finishTextEditor();
              }
            }}
          />
          {textEditor?.initial ? (
            <button
              aria-label="删除文本"
              type="button"
              onPointerDown={() => {
                suppressTextBlur.current = true;
              }}
              onClick={() => {
                if (!activeLayerId) return;
                void saveDraftWithHistory(workspace, {
                  id: textEditor.id,
                  layerId: activeLayerId,
                  payload: null,
                  deleted: true,
                });
                closeTextEditor();
              }}
            >
              <Trash2 aria-hidden="true" size={18} />
            </button>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function distanceToPolyline(
  point: { x: number; y: number },
  points: Array<{ x: number; y: number }>,
) {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    closest = Math.min(
      closest,
      distanceToSegment(point, points[index - 1]!, points[index]!),
    );
  }
  return closest;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) /
      (dx * dx + dy * dy),
  );
  return Math.hypot(
    point.x - (start.x + ratio * dx),
    point.y - (start.y + ratio * dy),
  );
}
