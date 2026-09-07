import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { Trash2 } from "lucide-react";

import {
  DEFAULT_TEXT_FONT_SCALE,
  MAX_TEXT_FONT_SCALE,
  MIN_TEXT_FONT_SCALE,
  type AnnotationLayerSummary,
  type AnnotationPayload,
} from "../../shared/annotations";
import type { LocalAnnotationRecord } from "../platform/local-database";
import type { AnnotationEditor } from "./annotation-editor";
import { useEditorPersistence } from "./use-annotation-editor";
import { calculateTextEditorLayout } from "./text-editor-layout";

export type AnnotationTool = "text" | "ink" | "eraser";
export type AnnotationOverlayInteraction =
  | "idle"
  | "composing-text"
  | "transforming-text";

type TextPayload = Extract<AnnotationPayload, { kind: "text" }>;

const ERASER_HIT_RADIUS_PX = 14;
const TEXT_DRAG_THRESHOLD_PX = 6;

interface TextEditorBase {
  id: string;
  x: number;
  y: number;
  initial: string;
  fontScale: number;
  pageWidth: number;
}

type TextEditorState = TextEditorBase &
  ({ source: "new" } | { source: "existing" });

interface TextTransformState {
  id: string;
  layerId: string;
  payload: TextPayload;
  preview: TextPayload;
  element: HTMLButtonElement;
  pointers: Map<number, { startX: number; startY: number; x: number; y: number }>;
  pinch: {
    distance: number;
    centerX: number;
    centerY: number;
    payload: TextPayload;
  } | null;
  moved: boolean;
}

interface PendingTextPlacement {
  pointerId: number;
  startX: number;
  startY: number;
  editor: TextEditorState;
  moved: boolean;
  opened: boolean;
}

interface TextSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

export function AnnotationOverlay({
  editor,
  pageNumber,
  layers,
  annotations,
  editing,
  tool,
  activeLayerId,
  onInteractionChange,
}: {
  editor: AnnotationEditor | null;
  pageNumber: number;
  layers: AnnotationLayerSummary[];
  annotations: LocalAnnotationRecord[];
  editing: boolean;
  tool: AnnotationTool;
  activeLayerId: string | null;
  onInteractionChange?(interaction: AnnotationOverlayInteraction): void;
}) {
  const persistence = useEditorPersistence(editor);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [draftStroke, setDraftStroke] = useState<Extract<AnnotationPayload, { kind: "ink" }> | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [editorText, setEditorText] = useState("");
  const [editorFontScale, setEditorFontScale] = useState(DEFAULT_TEXT_FONT_SCALE);
  const [fontScaleAdjusting, setFontScaleAdjusting] = useState(false);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const textComposerHeaderRef = useRef<HTMLElement>(null);
  const pendingTextPlacement = useRef<PendingTextPlacement | null>(null);
  const textSelection = useRef<TextSelection | null>(null);
  const currentStrokeId = useRef<string | null>(null);
  const strokeHistoryStarted = useRef(false);
  const eraserPointerId = useRef<number | null>(null);
  const erasedStrokeIds = useRef(new Set<string>());
  const textTransform = useRef<TextTransformState | null>(null);
  const [textTransformPreview, setTextTransformPreview] = useState<{
    id: string;
    payload: TextPayload;
  } | null>(null);
  const [transformingText, setTransformingText] = useState(false);
  const interactionRef = useRef<AnnotationOverlayInteraction>("idle");
  const [deleteActive, setDeleteActive] = useState(false);
  const deleteActiveRef = useRef(false);
  const deleteTargetRef = useRef<HTMLDivElement>(null);
  const visualViewport = useVisualViewport(editing);
  const canStartEdit = editing && layers.some(layer => layer.id === activeLayerId && layer.canEdit);
  const visibleLayerIds = new Set(
    layers
      .filter((layer) => (editing ? layer.id === activeLayerId : layer.subscribed))
      .map((layer) => layer.id),
  );
  const layerColors = new Map(
    layers.map((layer) => [layer.id, layer.displayColor]),
  );
  const activeLayerColor = layerColors.get(activeLayerId ?? "") ?? "#a12652";
  const editorFontSize = textEditor
    ? clampRange(textEditor.pageWidth * editorFontScale, 12, 96)
    : 12;
  const editorFontScaleProgress =
    (editorFontScale - MIN_TEXT_FONT_SCALE) /
    (MAX_TEXT_FONT_SCALE - MIN_TEXT_FONT_SCALE);
  const pageAnnotations = annotations.filter(
    (annotation) =>
      annotation.payload?.pageNumber === pageNumber &&
      visibleLayerIds.has(annotation.layerId),
  );

  useLayoutEffect(() => {
    const input = textInputRef.current;
    if (!input || !textEditor) return;
    const headerBottom =
      textComposerHeaderRef.current?.getBoundingClientRect().bottom ?? 0;
    input.style.height = "auto";
    const contentHeight = input.scrollHeight;
    const layout = calculateTextEditorLayout({
      fontSize: editorFontSize,
      contentHeight,
      viewportHeight: visualViewport.height,
      viewportTop: visualViewport.top,
      headerBottom,
    });
    input.style.height = `${layout.height}px`;
    input.style.overflowY = layout.overflowY;
    if (layout.overflowY === "auto" && input.selectionEnd === input.value.length) {
      input.scrollTop = contentHeight;
    }
  }, [
    editorFontSize,
    editorText,
    textEditor,
    visualViewport.height,
    visualViewport.top,
    visualViewport.width,
  ]);

  const updateInteraction = (interaction: AnnotationOverlayInteraction) => {
    if (interactionRef.current === interaction) return;
    interactionRef.current = interaction;
    setTransformingText(interaction === "transforming-text");
    onInteractionChange?.(interaction);
  };

  useEffect(
    () => () => {
      if (interactionRef.current !== "idle") onInteractionChange?.("idle");
    },
    [onInteractionChange],
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
    const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
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
      void editor?.persist({
        id: annotation.id,
        layerId: annotation.layerId,
        payload: null,
        deleted: true,
      }).catch(() => erasedStrokeIds.current.delete(annotation.id));
    }
  };

  const focusTextInput = (selection?: TextSelection | null) => {
    const input = textInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    if (selection) {
      input.setSelectionRange(
        selection.start,
        selection.end,
        selection.direction,
      );
    }
  };

  const openTextEditor = (editor: TextEditorState) => {
    flushSync(() => {
      setEditorText(editor.initial);
      setEditorFontScale(editor.fontScale);
      setFontScaleAdjusting(false);
      setTextEditor(editor);
      updateInteraction("composing-text");
    });
    const input = textInputRef.current;
    const cursor = editor.initial.length;
    input?.setSelectionRange(cursor, cursor, "none");
  };

  const closeTextEditor = () => {
    setFontScaleAdjusting(false);
    textSelection.current = null;
    pendingTextPlacement.current = null;
    setTextEditor(null);
    updateInteraction("idle");
    const input = textInputRef.current;
    if (input && input === document.activeElement) input.blur();
  };

  const cancelTextEditor = () => {
    if (persistence === "saving") return;
    if (textEditor) editor?.discard(textEditor.id);
    closeTextEditor();
  };

  const finishTextEditor = async () => {
    if (!textEditor) return true;
    if (!activeLayerId || persistence === "saving") return false;
    const textDraft = textEditor;
    const text = editorText.trim();
    if (!text) {
      if (textDraft.source === "existing") {
        const saved = await editor?.persist({
          id: textDraft.id,
          layerId: activeLayerId,
          payload: null,
          deleted: true,
        });
        if (!saved) return false;
      }
      closeTextEditor();
      return true;
    }
    const saved = await editor?.persist({
      id: textDraft.id,
      layerId: activeLayerId,
      payload: {
        kind: "text",
        pageNumber,
        x: textDraft.x,
        y: textDraft.y,
        fontScale: editorFontScale,
        text,
      },
    });
    if (saved) closeTextEditor();
    return Boolean(saved);
  };

  useEffect(() => { if (editing && textEditor) return editor?.registerTextCommit(finishTextEditor); });

  const addTransformPointer = (
    event: ReactPointerEvent<Element>,
    transform: TextTransformState,
  ) => {
    event.preventDefault();
    capturePointer(event.currentTarget, event.pointerId);
    transform.pointers.set(event.pointerId, {
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
    });
    if (transform.pointers.size === 2) {
      const [first, second] = [...transform.pointers.values()];
      transform.pinch = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        centerX: (first.x + second.x) / 2,
        centerY: (first.y + second.y) / 2,
        payload: transform.preview,
      };
    }
  };

  const beginTextTransform = (
    event: ReactPointerEvent<HTMLButtonElement>,
    annotation: LocalAnnotationRecord,
    payload: TextPayload,
  ) => {
    if (!canStartEdit || annotation.layerId !== activeLayerId || tool !== "text") return;
    if (textEditor) return;
    const active = textTransform.current;
    if (active?.id === annotation.id) {
      addTransformPointer(event, active);
      return;
    }
    const transform: TextTransformState = {
      id: annotation.id,
      layerId: annotation.layerId,
      payload,
      preview: payload,
      element: event.currentTarget,
      pointers: new Map(),
      pinch: null,
      moved: false,
    };
    textTransform.current = transform;
    setTextTransformPreview(null);
    addTransformPointer(event, transform);
  };

  const updateTextTransform = (event: ReactPointerEvent<Element>) => {
    const transform = textTransform.current;
    const pointer = transform?.pointers.get(event.pointerId);
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!transform || !pointer || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    let next: TextPayload;
    const entries = [...transform.pointers.values()];
    if (entries.length >= 2 && transform.pinch) {
      const [first, second] = entries;
      const centerX = (first.x + second.x) / 2;
      const centerY = (first.y + second.y) / 2;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      next = {
        ...transform.pinch.payload,
        x: transform.pinch.payload.x + (centerX - transform.pinch.centerX) / bounds.width,
        y: transform.pinch.payload.y + (centerY - transform.pinch.centerY) / bounds.height,
        fontScale: clampRange(
          transform.pinch.payload.fontScale * (distance / transform.pinch.distance),
          MIN_TEXT_FONT_SCALE,
          MAX_TEXT_FONT_SCALE,
        ),
      };
      transform.moved = true;
    } else {
      const distance = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY);
      if (!transform.moved && distance <= TEXT_DRAG_THRESHOLD_PX) return;
      transform.moved = true;
      next = {
        ...transform.preview,
        x: transform.preview.x + (pointer.x - pointer.startX) / bounds.width,
        y: transform.preview.y + (pointer.y - pointer.startY) / bounds.height,
      };
      pointer.startX = pointer.x;
      pointer.startY = pointer.y;
    }

    const clamped = clampTextToPage(next, transform.element, bounds);
    transform.preview = clamped;
    setTextTransformPreview({ id: transform.id, payload: clamped });
    updateInteraction("transforming-text");
    const centerX = entries.reduce((total, entry) => total + entry.x, 0) / entries.length;
    const centerY = entries.reduce((total, entry) => total + entry.y, 0) / entries.length;
    const deleteBounds = deleteTargetRef.current?.getBoundingClientRect();
    const inDeleteZone = deleteBounds
      ? Math.hypot(
          centerX - (deleteBounds.left + deleteBounds.width / 2),
          centerY - (deleteBounds.top + deleteBounds.height / 2),
        ) <= Math.min(deleteBounds.width, deleteBounds.height) / 2
      : false;
    deleteActiveRef.current = inDeleteZone;
    setDeleteActive(inDeleteZone);
  };

  const finishTextTransform = (event: ReactPointerEvent<Element>) => {
    const transform = textTransform.current;
    if (!transform?.pointers.has(event.pointerId)) return;
    transform.pointers.delete(event.pointerId);
    if (transform.pointers.size > 0) {
      const [remaining] = transform.pointers.values();
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
      transform.pinch = null;
      return;
    }
    textTransform.current = null;
    setTextTransformPreview(null);
    updateInteraction("idle");
    setDeleteActive(false);
    const shouldDelete = deleteActiveRef.current;
    deleteActiveRef.current = false;
    if (!transform.moved) {
      const bounds = overlayRef.current?.getBoundingClientRect();
      openTextEditor({
        id: transform.id,
        x: transform.payload.x,
        y: transform.payload.y,
        initial: transform.payload.text,
        fontScale: transform.payload.fontScale,
        pageWidth: bounds?.width ?? 640,
        source: "existing",
      });
      return;
    }
    void editor?.persist({
      id: transform.id,
      layerId: transform.layerId,
      payload: shouldDelete ? null : transform.preview,
      deleted: shouldDelete,
    });
  };

  const cancelTextTransform = () => {
    textTransform.current = null;
    setTextTransformPreview(null);
    updateInteraction("idle");
    setDeleteActive(false);
    deleteActiveRef.current = false;
  };

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!canStartEdit || !activeLayerId) return;
    if (tool === "text") {
      if (textTransform.current) {
        addTransformPointer(event, textTransform.current);
        return;
      }
      if (textEditor || pendingTextPlacement.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = point(event);
      capturePointer(event.currentTarget, event.pointerId);
      const editor: TextEditorState = {
        id: crypto.randomUUID(),
        x: position.x,
        y: position.y,
        initial: "",
        fontScale: DEFAULT_TEXT_FONT_SCALE,
        pageWidth: bounds.width,
        source: "new",
      };
      const openOnPointerDown = event.pointerType === "pen";
      pendingTextPlacement.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        opened: openOnPointerDown,
        editor,
      };
      // Mount the native control during Pencil pointerdown so the editing
      // session starts with a focused input. iPadOS still decides whether that
      // input uses Scribble or the full-width software keyboard.
      if (openOnPointerDown) openTextEditor(editor);
      return;
    }
    if (tool === "eraser") {
      capturePointer(event.currentTarget, event.pointerId);
      eraserPointerId.current = event.pointerId;
      erasedStrokeIds.current.clear();
      eraseAt(event);
      return;
    }
    if (tool !== "ink") return;
    capturePointer(event.currentTarget, event.pointerId);
    const position = point(event);
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
    const pendingPlacement = pendingTextPlacement.current;
    if (pendingPlacement?.pointerId === event.pointerId) {
      if (
        Math.hypot(
          event.clientX - pendingPlacement.startX,
          event.clientY - pendingPlacement.startY,
        ) > TEXT_DRAG_THRESHOLD_PX
      ) {
        pendingPlacement.moved = true;
        if (pendingPlacement.opened) {
          pendingPlacement.opened = false;
          closeTextEditor();
        }
      }
      return;
    }
    if (textTransform.current?.pointers.has(event.pointerId)) {
      updateTextTransform(event);
      return;
    }
    if (editing && tool === "eraser" && eraserPointerId.current === event.pointerId) {
      eraseAt(event);
      return;
    }
    if (!editing || tool !== "ink" || !currentStrokeId.current || !activeLayerId) return;
    const position = point(event);
    setDraftStroke((current) => {
      if (!current) return current;
      const next = { ...current, points: [...current.points, position] };
      const input = { id: currentStrokeId.current!, layerId: activeLayerId, payload: next };
      if (strokeHistoryStarted.current) {
        void editor?.persist(input, true);
      } else {
        strokeHistoryStarted.current = true;
        void editor?.persist(input);
      }
      return next;
    });
  };

  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pendingPlacement = pendingTextPlacement.current;
    if (pendingPlacement?.pointerId === event.pointerId) {
      pendingTextPlacement.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!pendingPlacement.moved && !pendingPlacement.opened) {
        openTextEditor(pendingPlacement.editor);
      }
      return;
    }
    if (textTransform.current?.pointers.has(event.pointerId)) {
      finishTextTransform(event);
      return;
    }
    if (eraserPointerId.current === event.pointerId || currentStrokeId.current !== null) {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
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
    <>
      <div
        className="annotation-overlay"
        data-editing={editing || undefined}
        data-tool={editing ? tool : undefined}
        ref={overlayRef}
      >
      <svg
        aria-label={`第 ${pageNumber} 页批注层`}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={(event) => {
          if (pendingTextPlacement.current?.pointerId === event.pointerId) {
            if (pendingTextPlacement.current.opened) closeTextEditor();
            pendingTextPlacement.current = null;
          } else if (textTransform.current?.pointers.has(event.pointerId)) cancelTextTransform();
          else pointerUp(event);
        }}
      >
        {pageAnnotations.map((annotation) => {
          const payload = annotation.payload;
          const color = layerColors.get(annotation.layerId) ?? "#a12652";
          if (payload?.kind !== "ink") return null;
          return (
            <g key={annotation.id}>
              {editing && tool === "eraser" && annotation.layerId === activeLayerId ? (
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
        })}
        {editing && draftStroke ? (
          <polyline
            points={draftStroke.points.map((entry) => `${entry.x * 1000},${entry.y * 1000}`).join(" ")}
            fill="none"
            stroke={activeLayerColor}
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
        const position = textTransformPreview?.id === annotation.id
          ? textTransformPreview.payload
          : payload;
        return (
          <button
            className="annotation-text"
            style={{
              left: `${position.x * 100}%`,
              top: `${position.y * 100}%`,
              color: layerColors.get(annotation.layerId) ?? "#a12652",
              fontSize: `${position.fontScale * 100}cqw`,
            }}
            key={annotation.id}
            disabled={!canStartEdit || annotation.layerId !== activeLayerId}
            onPointerDown={(event) => beginTextTransform(event, annotation, payload)}
            onPointerMove={updateTextTransform}
            onPointerUp={finishTextTransform}
            onPointerCancel={cancelTextTransform}
            onKeyDown={(event) => {
              if (event.key === "Delete" || event.key === "Backspace") {
                void editor?.persist({
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

      </div>
      {editing ? createPortal(
        <>
          {!canStartEdit && <aside className="annotation-storage-error" role="status">
            <strong>此层已停止编辑</strong>
            <p>共享层已停用、删除或权限已改变。当前输入可完成并保存在原层的本机草稿中；不会上传或转写其他层。</p>
          </aside>}
          {persistence === "failed" && <aside className="annotation-storage-error" role="alert">
            <strong>本机保存失败</strong>
            <p>修改仍留在当前编辑器，尚未可靠保存。请保留此页面，释放设备空间后重试。</p>
            <button type="button" onClick={() => void editor?.retry()}>重试本机保存</button>
          </aside>}
          {canStartEdit && tool === "text" && !textEditor && !transformingText ? (
            <p className="annotation-text-hint" role="status">轻点任意位置添加文字</p>
          ) : null}

          <div
            aria-hidden={transformingText ? undefined : "true"}
            aria-label="拖到这里删除"
            className="annotation-delete-zone"
            data-active={deleteActive || undefined}
            data-visible={transformingText || undefined}
            ref={deleteTargetRef}
            role="status"
          >
            <Trash2 aria-hidden="true" />
          </div>

          <form
        aria-label={textEditor ? "文字输入" : undefined}
        aria-hidden={textEditor ? undefined : "true"}
        className="annotation-text-composer"
        data-active={textEditor ? "true" : undefined}
        style={{
          top: visualViewport.top,
          left: visualViewport.left,
          width: visualViewport.width,
          height: visualViewport.height,
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void finishTextEditor();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) void finishTextEditor();
        }}
      >
        <header ref={textComposerHeaderRef}>
          <button
            tabIndex={textEditor ? 0 : -1}
            type="button"
            disabled={persistence === "saving"}
            onClick={cancelTextEditor}
          >
            取消
          </button>
          <button tabIndex={textEditor ? 0 : -1} type="submit">完成</button>
        </header>
        {textEditor ? (
          <textarea
            aria-label="批注文本"
            autoFocus
            name="text"
            disabled={persistence === "saving"}
            ref={textInputRef}
            inputMode="text"
            maxLength={1000}
            rows={2}
            style={{
              color: activeLayerColor,
              fontSize: editorFontSize,
            }}
            value={editorText}
            onChange={(event) => setEditorText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancelTextEditor();
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void finishTextEditor();
              }
            }}
          />
        ) : null}
        <label className="annotation-font-scale">
          <output
            aria-hidden={fontScaleAdjusting ? undefined : "true"}
            className="annotation-font-scale__value"
            data-visible={fontScaleAdjusting || undefined}
          >
            {Math.round(editorFontSize)}
          </output>
          <span className="annotation-font-scale__control">
            <span aria-hidden="true" className="annotation-font-scale__track" />
            <span
              aria-hidden="true"
              className="annotation-font-scale__thumb"
              style={{ bottom: `${editorFontScaleProgress * 100}%` }}
            />
            <input
              aria-label="字号"
              type="range"
            disabled={persistence === "saving"}
              min={MIN_TEXT_FONT_SCALE}
              max={MAX_TEXT_FONT_SCALE}
              step="0.001"
              value={editorFontScale}
              onChange={(event) => setEditorFontScale(Number(event.target.value))}
              onPointerDown={() => {
                const input = textInputRef.current;
                textSelection.current = input
                  ? {
                      start: input.selectionStart,
                      end: input.selectionEnd,
                      direction: input.selectionDirection,
                    }
                  : null;
                setFontScaleAdjusting(true);
              }}
              onPointerCancel={() => {
                setFontScaleAdjusting(false);
                focusTextInput(textSelection.current);
              }}
              onPointerUp={() => {
                setFontScaleAdjusting(false);
                focusTextInput(textSelection.current);
              }}
            />
          </span>
        </label>
          </form>
        </>,
        document.body,
      ) : null}
    </>
  );
}

function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Synthetic pointer events used by tests and visual QA have no active browser pointer.
  }
}

function useVisualViewport(enabled: boolean) {
  const read = () => ({
    top: window.visualViewport?.offsetTop ?? 0,
    left: window.visualViewport?.offsetLeft ?? 0,
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  });
  const [viewport, setViewport] = useState(read);
  useEffect(() => {
    if (!enabled) return;
    const target = window.visualViewport;
    const update = () => setViewport(read());
    target?.addEventListener("resize", update);
    target?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      target?.removeEventListener("resize", update);
      target?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);
  return viewport;
}

function clampTextToPage(payload: TextPayload, element: HTMLElement, pageBounds: DOMRect): TextPayload {
  const previousFontSize = element.style.fontSize;
  let textBounds: DOMRect;
  try {
    element.style.fontSize = `${payload.fontScale * 100}cqw`;
    textBounds = element.getBoundingClientRect();
  } finally {
    element.style.fontSize = previousFontSize;
  }
  const halfWidth = Math.min(0.49, textBounds.width / pageBounds.width / 2);
  const halfHeight = Math.min(0.49, textBounds.height / pageBounds.height / 2);
  return {
    ...payload,
    x: clampRange(payload.x, halfWidth, 1 - halfWidth),
    y: clampRange(payload.y, halfHeight, 1 - halfHeight),
  };
}

function clamp(value: number) {
  return clampRange(value, 0, 1);
}

function clampRange(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distanceToPolyline(
  point: { x: number; y: number },
  points: Array<{ x: number; y: number }>,
) {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    closest = Math.min(closest, distanceToSegment(point, points[index - 1]!, points[index]!));
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
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
  );
  return Math.hypot(
    point.x - (start.x + ratio * dx),
    point.y - (start.y + ratio * dy),
  );
}
