import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";

import type {
  AnnotationLayerSummary,
  AnnotationPayload,
} from "../../shared/annotations";
import type { LocalAnnotationRecord } from "../platform/local-database";
import {
  saveDraftWithHistory,
  updateLatestHistoryDraft,
} from "./edit-history";

export type AnnotationTool = "text" | "ink" | "eraser";

export function AnnotationOverlay({
  choirId,
  scoreId,
  pageNumber,
  layers,
  annotations,
  editing,
  tool,
  activeLayerId,
}: {
  choirId: string;
  scoreId: string;
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
  const currentStrokeId = useRef<string | null>(null);
  const strokeHistoryStarted = useRef(false);
  const dragText = useRef<{ id: string; startX: number; startY: number; payload: Extract<AnnotationPayload, { kind: "text" }> } | null>(null);
  const visibleLayerIds = new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id));
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

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!editing || !activeLayerId) return;
    const position = point(event);
    if (tool === "text") {
      setTextEditor({ id: crypto.randomUUID(), x: position.x, y: position.y, initial: "" });
      return;
    }
    if (tool !== "ink") return;
    event.currentTarget.setPointerCapture(event.pointerId);
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
        void updateLatestHistoryDraft(choirId, scoreId, input);
      } else {
        strokeHistoryStarted.current = true;
        void saveDraftWithHistory(choirId, scoreId, input);
      }
      return next;
    });
  };

  const pointerUp = () => {
    setDraftStroke(null);
    currentStrokeId.current = null;
    strokeHistoryStarted.current = false;
  };

  const saveText = async (value: string) => {
    if (!textEditor || !activeLayerId) return;
    const text = value.trim();
    if (text) {
      await saveDraftWithHistory(choirId, scoreId, {
        id: textEditor.id,
        layerId: activeLayerId,
        payload: {
          kind: "text",
          pageNumber,
          x: textEditor.x,
          y: textEditor.y,
          text,
        },
      });
    }
    setTextEditor(null);
  };

  return (
    <div className="annotation-overlay" data-editing={editing || undefined}>
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
              <polyline
                key={annotation.id}
                points={payload.points.map((entry) => `${entry.x * 1000},${entry.y * 1000}`).join(" ")}
                fill="none"
                stroke={color}
                strokeWidth={payload.strokeWidth * 1000}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                data-erasable={editing && tool === "eraser" || undefined}
                onPointerDown={(event) => {
                  if (!editing || tool !== "eraser" || annotation.layerId !== activeLayerId) return;
                  event.stopPropagation();
                  void saveDraftWithHistory(choirId, scoreId, {
                    id: annotation.id,
                    layerId: annotation.layerId,
                    payload: null,
                    deleted: true,
                  });
                }}
              />
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
        return (
          <button
            className="annotation-text"
            style={{
              left: `${payload.x * 100}%`,
              top: `${payload.y * 100}%`,
              color: layerColors.get(annotation.layerId) ?? "#a12652",
            }}
            key={annotation.id}
            disabled={!editing || annotation.layerId !== activeLayerId}
            onPointerDown={(event) => {
              if (!editing || annotation.layerId !== activeLayerId || tool !== "text") return;
              dragText.current = {
                id: annotation.id,
                startX: event.clientX,
                startY: event.clientY,
                payload,
              };
            }}
            onPointerUp={(event) => {
              const drag = dragText.current;
              dragText.current = null;
              if (!drag || tool !== "text") return;
              const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
              const dx = (event.clientX - drag.startX) / bounds.width;
              const dy = (event.clientY - drag.startY) / bounds.height;
              if (Math.hypot(dx, dy) > 0.006) {
                void saveDraftWithHistory(choirId, scoreId, {
                  id: annotation.id,
                  layerId: annotation.layerId,
                  payload: { ...payload, x: clamp(payload.x + dx), y: clamp(payload.y + dy) },
                });
              } else {
                setTextEditor({ id: annotation.id, x: payload.x, y: payload.y, initial: payload.text });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Delete" || event.key === "Backspace") {
                void saveDraftWithHistory(choirId, scoreId, {
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
      {editing && textEditor ? (
        <form
          className="annotation-text-editor"
          style={{ left: `${textEditor.x * 100}%`, top: `${textEditor.y * 100}%` }}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void saveText(String(data.get("text") ?? ""));
          }}
        >
          <input
            aria-label="批注文本"
            name="text"
            defaultValue={textEditor.initial}
            autoFocus
            maxLength={1000}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setTextEditor(null);
              }
            }}
          />
          <button type="submit">保存</button>
          {textEditor.initial ? (
            <button
              type="button"
              onClick={() => {
                if (!activeLayerId) return;
                void saveDraftWithHistory(choirId, scoreId, {
                  id: textEditor.id,
                  layerId: activeLayerId,
                  payload: null,
                  deleted: true,
                });
                setTextEditor(null);
              }}
            >
              删除
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
