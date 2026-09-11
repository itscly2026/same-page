import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useEffectEvent,
  useId,
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

import { inkSvgPaths, inkHit, inkFillRule } from "./ink-geometry";
import { defaultToolStyle, type ToolStyle } from "./tool-style";
import { highlighterNibPath } from "./highlighter-geometry";
import { ObjectProperties } from "./object-properties";

export type AnnotationTool = "select" | "text" | "ink" | "highlighter" | "rectangle" | "ellipse" | "eraser";
export type AnnotationOverlayInteraction =
  | "idle"
  | "composing-text"
  | "transforming-object";

type TextPayload = Extract<AnnotationPayload, { kind: "text" }>;
type MovablePayload = Extract<AnnotationPayload, { kind: "text" | "shape" }>;

const ERASER_HIT_RADIUS_PX = 14;
const OBJECT_DRAG_THRESHOLD_PX = 6;

interface TextEditorBase {
  id: string;
  x: number;
  y: number;
  initial: string;
  fontScale: number;
  pageWidth: number;
  color?: string;
  openingPoint?: { x: number; y: number };
}

type TextEditorState = TextEditorBase &
  ({ source: "new" } | { source: "existing" });

interface ObjectTransformState {
  id: string;
  layerId: string;
  payload: MovablePayload;
  preview: MovablePayload;
  element: HTMLButtonElement;
  pointers: Map<number, { startX: number; startY: number; x: number; y: number }>;
  pinch: {
    distance: number;
    centerX: number;
    centerY: number;
    payload: MovablePayload;
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
  pageAspectRatio,
  layers,
  annotations,
  editing,
  tool,
  toolColor = tool === "highlighter" ? "#facc15" : "#dc2626",
  activeLayerId,
  toolStyle = defaultToolStyle(tool),
  onInteractionChange,
}: {
  editor: AnnotationEditor | null;
  pageNumber: number;
  pageAspectRatio?: number;
  layers: AnnotationLayerSummary[];
  annotations: LocalAnnotationRecord[];
  editing: boolean;
  tool: AnnotationTool;
  toolColor?: string;
  toolStyle?: ToolStyle;
  activeLayerId: string | null;
  onInteractionChange?(interaction: AnnotationOverlayInteraction): void;
}) {
  const persistence = useEditorPersistence(editor);
  const eraserGradientId = useId();
  const [pageWidth, setPageWidth] = useState(1000);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [measuredAspectRatio, setAspectRatio] = useState(1);
  const aspectRatio = pageAspectRatio ?? measuredAspectRatio;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<Extract<AnnotationPayload, { kind: "ink" }>["points"][number] | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [draftShape, setDraftShape] = useState<Extract<AnnotationPayload, { kind: "shape" }> | null>(null);
  const shapeStart = useRef<{ x: number; y: number } | null>(null);
  const [draftStroke, setDraftStroke] = useState<Extract<AnnotationPayload, { kind: "ink" }> | null>(null);
  const liveStroke = useRef<Extract<AnnotationPayload, { kind: "ink" }> | null>(null);
  const strokeFrame = useRef<number | null>(null);
  const lastCheckpoint = useRef(0);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const textSavingRef = useRef(false);
  const [textSaving, setTextSaving] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [editorFontScale, setEditorFontScale] = useState(DEFAULT_TEXT_FONT_SCALE);
  const [fontScaleAdjusting, setFontScaleAdjusting] = useState(false);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const textComposerHeaderRef = useRef<HTMLElement>(null);
  const pendingTextPlacement = useRef<PendingTextPlacement | null>(null);
  const openingPoint = useRef<{ x: number; y: number } | null>(null);
  const drawingPointer = useRef<number | null>(null);
  const backdropPointer = useRef<number | null>(null);
  const backdropReleased = useRef(false);
  const textSelection = useRef<TextSelection | null>(null);
  const currentStrokeId = useRef<string | null>(null);
  const eraserPointerId = useRef<number | null>(null);
  const erasedStrokeIds = useRef(new Set<string>());
  const [erasedPreview, setErasedPreview] = useState(new Set<string>());
  const objectTransform = useRef<ObjectTransformState | null>(null);
  const [objectTransformPreview, setObjectTransformPreview] = useState<{
    id: string;
    payload: MovablePayload;
  } | null>(null);
  // Keep released transforms visible until the local projection takes over.
  // Failed writes stay in the editor's retry queue and retain this preview.
  const [releasedTransforms, setReleasedTransforms] = useState<Map<string, { payload: MovablePayload; revision: number }>>(() => new Map());
  const projectedTransforms = new Map([...releasedTransforms].map(([id, released]) => {
    const committed = editor?.getCommittedObject(id);
    // A later undo/redo can commit before the live query delivers the dragged
    // position. Follow that newer intent instead of waiting for a skipped value.
    const payload = committed && committed.revision > released.revision
      ? committed.input.payload : released.payload;
    return [id, payload] as const;
  }));
  const acknowledged = [...projectedTransforms].filter(([id, payload]) => {
    const record = annotations.find(annotation => annotation.id === id);
    return payload === null ? !record || record.deleted : JSON.stringify(record?.payload) === JSON.stringify(payload);
  }).map(([id]) => id);
  if (acknowledged.length) {
    const next = new Map(releasedTransforms);
    acknowledged.forEach(id => next.delete(id));
    setReleasedTransforms(next);
  }
  const [transformingObject, setTransformingObject] = useState(false);
  const interactionRef = useRef<AnnotationOverlayInteraction>("idle");
  const [deleteActive, setDeleteActive] = useState(false);
  const deleteActiveRef = useRef(false);
  const deleteTargetRef = useRef<HTMLDivElement>(null);
  const visualViewport = useVisualViewport(editing);
  const finishing = persistence === "finishing";
  const canStartEdit = editing && !finishing && layers.some(layer => layer.id === activeLayerId && layer.canEdit);
  const canMoveObjects = canStartEdit && ["select", "text", "rectangle", "ellipse"].includes(tool);
  const visibleLayerIds = new Set(
    layers
      .filter((layer) => (editing ? layer.id === activeLayerId : layer.subscribed))
      .map((layer) => layer.id),
  );
  const layerColors = new Map(
    layers.filter(layer => layer.kind === "shared").map((layer) => [layer.id, layer.displayColor]),
  );
  const activeLayerColor = layerColors.get(activeLayerId ?? "") ?? toolColor;
  const editorFontSize = textEditor
    ? clampRange(textEditor.pageWidth * editorFontScale, 12, 96)
    : 12;
  const editorFontScaleProgress =
    (editorFontScale - MIN_TEXT_FONT_SCALE) /
    (MAX_TEXT_FONT_SCALE - MIN_TEXT_FONT_SCALE);
  const pageAnnotations = annotations.map(annotation => {
    return projectedTransforms.has(annotation.id) ? { ...annotation, payload: projectedTransforms.get(annotation.id) ?? null } : annotation;
  }).filter(
    (annotation) =>
      annotation.payload?.pageNumber === pageNumber &&
      visibleLayerIds.has(annotation.layerId),
  );

  const selected = pageAnnotations.find(annotation => annotation.id === selectedId && !annotation.deleted);

  useEffect(() => {
    const element = overlayRef.current;
    if (!element) return;
    const update = () => { const bounds = element.getBoundingClientRect(); if (bounds.height > 0) { setAspectRatio(bounds.width / bounds.height); setPageWidth(bounds.width); } };
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => editor?.registerFinishCommit(async () => {
    if (activeLayerId && erasedStrokeIds.current.size) {
      const ids = [...erasedStrokeIds.current];
      erasedStrokeIds.current.clear();
      eraserPointerId.current = null;
      const saved = await Promise.all(ids.map(id => editor.persist({ id, layerId: activeLayerId, payload: null, deleted: true })));
      setErasedPreview(new Set());
      if (!saved.every(Boolean)) return false;
    }
    if (!liveStroke.current || !currentStrokeId.current || !activeLayerId) return true;
    const saved = editor.persist({ id: currentStrokeId.current, layerId: activeLayerId, payload: liveStroke.current }, true);
    liveStroke.current = null;
    currentStrokeId.current = null;
    drawingPointer.current = null;
    if (strokeFrame.current !== null) cancelAnimationFrame(strokeFrame.current);
    strokeFrame.current = null;
    setDraftStroke(null);
    setDraftId(null);
    return saved;
  }), [editor, activeLayerId]);

  useEffect(() => {
    const flush = () => {
      if (liveStroke.current && currentStrokeId.current && activeLayerId) void editor?.persist({ id: currentStrokeId.current, layerId: activeLayerId, payload: liveStroke.current }, true);
    };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    return () => { flush(); if (strokeFrame.current !== null) cancelAnimationFrame(strokeFrame.current); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", flush); };
  }, [editor, activeLayerId]);

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
    setTransformingObject(interaction === "transforming-object");
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
      ...(event.pointerType === "pen" ? { tiltX: event.tiltX || 0, tiltY: event.tiltY || 0, twist: event.twist || 0 } : {}),
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
        !payload || payload.kind !== "ink" ||
        erasedStrokeIds.current.has(annotation.id)
      ) {
        continue;
      }
      if (!inkHit(payload, bounds.width, bounds.height, pointer.x, pointer.y, ERASER_HIT_RADIUS_PX)) continue;
      erasedStrokeIds.current.add(annotation.id);
      setErasedPreview(new Set(erasedStrokeIds.current));
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
    openingPoint.current = editor.openingPoint ?? null;
    backdropPointer.current = null;
    backdropReleased.current = false;
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
    if (textSavingRef.current) return;
    if (textEditor) editor?.discard(textEditor.id);
    closeTextEditor();
  };

  const commitTextEditor = async () => {
    if (!textEditor) return true;
    if (!activeLayerId) return false;
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
        color: textDraft.color ?? toolColor,
        text,
      },
    });
    if (saved) closeTextEditor();
    return Boolean(saved);
  };

  const finishTextEditor = async () => {
    if (textSavingRef.current) return false;
    textSavingRef.current = true;
    setTextSaving(true);
    try { return await commitTextEditor(); }
    finally { textSavingRef.current = false; setTextSaving(false); }
  };

  useEffect(() => { if (editing && textEditor) return editor?.registerFinishCommit(finishTextEditor); });

  const addTransformPointer = (
    event: ReactPointerEvent<Element>,
    transform: ObjectTransformState,
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

  const beginObjectTransform = (
    event: ReactPointerEvent<HTMLButtonElement>,
    annotation: LocalAnnotationRecord,
    payload: MovablePayload,
  ) => {
    if (!canMoveObjects || editor?.getSnapshot() === "finishing" || annotation.layerId !== activeLayerId) return;
    event.stopPropagation();
    if (textEditor) return;
    const active = objectTransform.current;
    if (active && active.id !== annotation.id) return;
    if (active?.id === annotation.id) {
      addTransformPointer(event, active);
      return;
    }
    const transform: ObjectTransformState = {
      id: annotation.id,
      layerId: annotation.layerId,
      payload,
      preview: payload,
      element: event.currentTarget,
      pointers: new Map(),
      pinch: null,
      moved: false,
    };
    objectTransform.current = transform;
    setObjectTransformPreview(null);
    addTransformPointer(event, transform);
  };

  const updateObjectTransform = (event: ReactPointerEvent<Element>) => {
    const transform = objectTransform.current;
    const pointer = transform?.pointers.get(event.pointerId);
    const bounds = overlayRef.current?.getBoundingClientRect();
    if (!transform || !pointer || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    let next: MovablePayload;
    const entries = [...transform.pointers.values()];
    if (entries.length >= 2 && transform.pinch) {
      const [first, second] = entries;
      const centerX = (first.x + second.x) / 2;
      const centerY = (first.y + second.y) / 2;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const base = transform.pinch.payload;
      const scale = distance / transform.pinch.distance;
      next = {
        ...base,
        x: transform.pinch.payload.x + (centerX - transform.pinch.centerX) / bounds.width,
        y: transform.pinch.payload.y + (centerY - transform.pinch.centerY) / bounds.height,
        ...(base.kind === "text" ? {
          fontScale: clampRange(base.fontScale * scale, MIN_TEXT_FONT_SCALE, MAX_TEXT_FONT_SCALE),
        } : {
          width: Math.min(1, base.width * scale),
          height: Math.min(1, base.height * scale),
        }),
      };
      transform.moved = true;
    } else {
      const distance = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY);
      if (!transform.moved && distance <= OBJECT_DRAG_THRESHOLD_PX) return;
      transform.moved = true;
      next = {
        ...transform.preview,
        x: transform.preview.x + (pointer.x - pointer.startX) / bounds.width,
        y: transform.preview.y + (pointer.y - pointer.startY) / bounds.height,
      };
      pointer.startX = pointer.x;
      pointer.startY = pointer.y;
    }

    const clamped = next.kind === "text"
      ? clampTextToPage(next, transform.element, bounds)
      : { ...next, x: clampRange(next.x, 0, 1 - next.width), y: clampRange(next.y, 0, 1 - next.height) };
    transform.preview = clamped;
    setObjectTransformPreview({ id: transform.id, payload: clamped });
    updateInteraction("transforming-object");
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

  const finishObjectTransform = (event: ReactPointerEvent<Element>) => {
    const transform = objectTransform.current;
    if (!transform?.pointers.has(event.pointerId)) return;
    transform.pointers.delete(event.pointerId);
    if (transform.pointers.size > 0) {
      const [remaining] = transform.pointers.values();
      remaining.startX = remaining.x;
      remaining.startY = remaining.y;
      transform.pinch = null;
      return;
    }
    objectTransform.current = null;
    setObjectTransformPreview(null);
    updateInteraction("idle");
    setDeleteActive(false);
    const shouldDelete = deleteActiveRef.current;
    deleteActiveRef.current = false;
    if (!transform.moved) {
      if (tool === "select") { setSelectedId(transform.id); return; }
      if (transform.payload.kind !== "text") return;
      const bounds = overlayRef.current?.getBoundingClientRect();
      openTextEditor({
        id: transform.id,
        x: transform.payload.x,
        y: transform.payload.y,
        initial: transform.payload.text,
        fontScale: transform.payload.fontScale,
        pageWidth: bounds?.width ?? 640,
        source: "existing",
        openingPoint: { x: event.clientX, y: event.clientY },
        color: transform.payload.color ?? "#dc2626",
      });
      return;
    }
    const revision = editor?.getEditRevision() ?? 0;
    if (!shouldDelete) setReleasedTransforms(previous => new Map(previous).set(transform.id, { payload: transform.preview, revision }));
    void editor?.persist({
      id: transform.id,
      layerId: transform.layerId,
      payload: shouldDelete ? null : transform.preview,
      deleted: shouldDelete,
    });
  };

  const cancelObjectTransform = () => {
    objectTransform.current = null;
    setObjectTransformPreview(null);
    updateInteraction("idle");
    setDeleteActive(false);
    deleteActiveRef.current = false;
  };

  const pointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!canStartEdit || editor?.getSnapshot() === "finishing" || !activeLayerId) return;
    setHover(null);
    if (objectTransform.current) {
      addTransformPointer(event, objectTransform.current);
      return;
    }
    if (tool === "select") {
      const bounds = event.currentTarget.getBoundingClientRect();
      const found = [...pageAnnotations].reverse().find(annotation => annotation.payload?.kind === "ink" && inkHit(annotation.payload, bounds.width, bounds.height, event.clientX - bounds.left, event.clientY - bounds.top, 8));
      setSelectedId(found?.id ?? null);
      return;
    }
    if (tool === "text") {
      if (textEditor || pendingTextPlacement.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const position = point(event);
      capturePointer(event.currentTarget, event.pointerId);
      const editor: TextEditorState = {
        id: crypto.randomUUID(),
        x: position.x,
        y: position.y,
        initial: "",
        fontScale: toolStyle.fontScale,
        pageWidth: bounds.width,
        source: "new",
        openingPoint: { x: event.clientX, y: event.clientY },
        color: toolColor,
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
    if (drawingPointer.current !== null) return;
    drawingPointer.current = event.pointerId;
    if (tool === "rectangle" || tool === "ellipse") {
      capturePointer(event.currentTarget, event.pointerId);
      shapeStart.current = point(event);
      currentStrokeId.current = crypto.randomUUID();
      setDraftShape({ kind: "shape", shape: tool, pageNumber, ...shapeStart.current, width: 0, height: 0, strokeWidth: toolStyle.strokeWidth, color: toolColor });
      return;
    }
    if (tool !== "ink" && tool !== "highlighter") return;
    capturePointer(event.currentTarget, event.pointerId);
    const position = point(event);
    currentStrokeId.current = crypto.randomUUID();
    const initialStroke: Extract<AnnotationPayload, { kind: "ink" }> = {
      kind: "ink",
      pageNumber,
      points: [position, position],
      brush: tool === "highlighter" ? "highlighter" : "pen",
      nib: tool === "highlighter" ? toolStyle.nib : "round",
      pressureMode: tool === "ink" ? toolStyle.pressureMode : "uniform",
      strokeWidth: toolStyle.strokeWidth,
      opacity: tool === "highlighter" ? toolStyle.opacity : 1,
      color: toolColor,
    };
    setDraftId(currentStrokeId.current);
    liveStroke.current = initialStroke;
    setDraftStroke({ ...initialStroke, points: [...initialStroke.points] });
    void editor?.persist({ id: currentStrokeId.current, layerId: activeLayerId, payload: initialStroke });
    lastCheckpoint.current = event.timeStamp;
  };

  const pointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (editor?.getSnapshot() === "finishing") return;
    if (canStartEdit && event.pointerType === "pen" && event.buttons === 0 && drawingPointer.current === null && !pendingTextPlacement.current && !objectTransform.current && eraserPointerId.current === null) {
      setHover(point(event)); return;
    }
    setHover(null);
    const pendingPlacement = pendingTextPlacement.current;
    if (pendingPlacement?.pointerId === event.pointerId) {
      if (
        Math.hypot(
          event.clientX - pendingPlacement.startX,
          event.clientY - pendingPlacement.startY,
        ) > OBJECT_DRAG_THRESHOLD_PX
      ) {
        pendingPlacement.moved = true;
        if (pendingPlacement.opened) {
          pendingPlacement.opened = false;
          closeTextEditor();
        }
      }
      return;
    }
    if (objectTransform.current?.pointers.has(event.pointerId)) {
      updateObjectTransform(event);
      return;
    }
    if (editing && tool === "eraser" && eraserPointerId.current === event.pointerId) {
      eraseAt(event);
      return;
    }
    if (drawingPointer.current !== null && drawingPointer.current !== event.pointerId) return;
    if (draftShape && shapeStart.current) {
      const position = point(event), start = shapeStart.current;
      setDraftShape({ ...draftShape, x: Math.min(start.x, position.x), y: Math.min(start.y, position.y), width: Math.abs(position.x - start.x), height: Math.abs(position.y - start.y) });
      return;
    }
    if (!editing || (tool !== "ink" && tool !== "highlighter") || !currentStrokeId.current || !activeLayerId) return;
    const position = point(event);
    const current = liveStroke.current;
    if (!current) return;
    // The mutable input buffer is independent of React and persisted snapshots.
    // Keep long gestures writable within the persisted point budget. Retain
    // both ends while reducing older sample density before accepting new input.
    if (current.points.length >= 5000) current.points = current.points.filter((_, index, points) => index % 2 === 0 || index === points.length - 1);
    current.points.push(position);
    if (strokeFrame.current === null) strokeFrame.current = requestAnimationFrame(() => {
      strokeFrame.current = null;
      if (liveStroke.current) setDraftStroke({ ...liveStroke.current, points: [...liveStroke.current.points] });
    });
    if (event.timeStamp - lastCheckpoint.current >= 120) {
      lastCheckpoint.current = event.timeStamp;
      void editor?.persist({ id: currentStrokeId.current, layerId: activeLayerId, payload: current }, true);
    }

  };

  const pointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (editor?.getSnapshot() === "finishing") return;
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
    if (objectTransform.current?.pointers.has(event.pointerId)) {
      finishObjectTransform(event);
      return;
    }
    if (drawingPointer.current !== null && drawingPointer.current !== event.pointerId) return;
    drawingPointer.current = null;
    if (eraserPointerId.current === event.pointerId || currentStrokeId.current !== null) {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
    if (draftShape && activeLayerId && currentStrokeId.current && draftShape.width > 0 && draftShape.height > 0) {
      void editor?.persist({ id: currentStrokeId.current, layerId: activeLayerId, payload: draftShape });
    }
    setDraftShape(null); shapeStart.current = null;
    if (liveStroke.current && currentStrokeId.current && activeLayerId) {
      if (event.type !== "pointercancel" && liveStroke.current.points.length < 5000) {
        const finalPoint = point(event), last = liveStroke.current.points.at(-1)!;
        if (finalPoint.x !== last.x || finalPoint.y !== last.y) liveStroke.current.points.push(finalPoint);
      }
      void editor?.persist({ id: currentStrokeId.current, layerId: activeLayerId, payload: liveStroke.current }, true);
    }
    liveStroke.current = null;
    setDraftId(null);
    if (strokeFrame.current !== null) cancelAnimationFrame(strokeFrame.current);
    strokeFrame.current = null;
    setDraftStroke(null);
    currentStrokeId.current = null;
    eraserPointerId.current = null;
    if (activeLayerId && event.type !== "pointercancel") {
      for (const id of erasedStrokeIds.current) void editor?.persist({ id, layerId: activeLayerId, payload: null, deleted: true });
    }
    erasedStrokeIds.current.clear();
    setErasedPreview(new Set());
  };

  const cancelForNavigation = useEffectEvent(() => {
    setHover(null);
    pendingTextPlacement.current = null;
    cancelObjectTransform();
    const id = currentStrokeId.current;
    if (id && activeLayerId && liveStroke.current) {
      // Remove any durable checkpoints from the interrupted stroke too.
      void editor?.persist({ id, layerId: activeLayerId, payload: null, deleted: true }, true);
    }
    currentStrokeId.current = null;
    drawingPointer.current = null;
    liveStroke.current = null;
    shapeStart.current = null;
    eraserPointerId.current = null;
    erasedStrokeIds.current.clear();
    if (strokeFrame.current !== null) cancelAnimationFrame(strokeFrame.current);
    strokeFrame.current = null;
    setDraftStroke(null);
    setDraftId(null);
    setDraftShape(null);
    setErasedPreview(new Set());
  });
  useEffect(() => {
    const viewport = overlayRef.current?.closest(".page-reader__viewport, .continuous-reader");
    const cancel = () => cancelForNavigation();
    viewport?.addEventListener("reader-navigation-start", cancel);
    return () => viewport?.removeEventListener("reader-navigation-start", cancel);
  }, []);
  const previousTool = useRef(tool);
  useLayoutEffect(() => {
    if (previousTool.current === tool) return;
    previousTool.current = tool;
    // Retire the previous pointer interaction before the new tool can paint.
    cancelForNavigation();
  }, [tool]);

  return (
    <>
      <div
        className="annotation-overlay"
        data-editing={editing || undefined}
        data-tool={editing ? tool : undefined}
        ref={overlayRef}
      >
      <svg
        aria-label={`第 ${pageNumber} 页笔记层`}
        viewBox="0 0 1000 1000"
        preserveAspectRatio="none"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerLeave={() => setHover(null)}
        onPointerUp={pointerUp}
        onPointerCancel={(event) => {
          if (pendingTextPlacement.current?.pointerId === event.pointerId) {
            if (pendingTextPlacement.current.opened) closeTextEditor();
            pendingTextPlacement.current = null;
          } else if (objectTransform.current?.pointers.has(event.pointerId)) cancelObjectTransform();
          else if (draftShape) { setDraftShape(null); shapeStart.current = null; currentStrokeId.current = null; drawingPointer.current = null; }
          else pointerUp(event);
        }}
      >
        {pageAnnotations.map((annotation) => {
          if (erasedPreview.has(annotation.id)) return null;
          const payload = annotation.payload;
          const color = layerColors.get(annotation.layerId) ?? payload?.color ?? "#dc2626";
          if (payload?.kind === "shape") {
            const position = objectTransformPreview?.id === annotation.id && objectTransformPreview.payload.kind === "shape"
              ? objectTransformPreview.payload : payload;
            return <ShapePreview key={annotation.id} payload={position} color={color} />;
          }
          if (payload?.kind !== "ink" || annotation.id === draftId) return null;
          return (
            <g key={annotation.id} role={canStartEdit && tool === "select" ? "button" : undefined} tabIndex={canStartEdit && tool === "select" ? 0 : undefined} aria-label={canStartEdit && tool === "select" ? payload.brush === "highlighter" ? "荧光笔笔记" : "画笔笔记" : undefined} onKeyDown={event => { if (tool === "select" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedId(annotation.id); } }}>
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
              {inkSvgPaths(payload, aspectRatio).map((path, index) => <path key={index} data-ink-stroke d={path} fill={color} fillRule={inkFillRule(payload)} opacity={payload.opacity ?? 1} />)}
              {selectedId === annotation.id && tool === "select" && <path d={inkSvgPaths(payload, aspectRatio).join("")} fill="none" stroke="#014653" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />}

            </g>
          );
        })}
        {editing && draftShape ? <ShapePreview payload={draftShape} color={activeLayerColor} /> : null}
        {editing && draftStroke ? (
          <g>{inkSvgPaths(draftStroke, aspectRatio).map((path, index) => <path key={index} data-ink-draft d={path} fill={activeLayerColor} fillRule={inkFillRule(draftStroke)} opacity={draftStroke.opacity ?? 1} />)}</g>
        ) : null}
        {hover && canStartEdit && <g pointerEvents="none" aria-label="笔尖预览">
          {tool === "eraser" && <defs>
            <radialGradient id={eraserGradientId}>
              <stop offset="0" stopColor="#203b3b" />
              <stop offset="45%" stopColor="#203b3b" stopOpacity=".45" />
              <stop offset="75%" stopColor="#203b3b" stopOpacity=".12" />
              <stop offset="100%" stopColor="#203b3b" stopOpacity="0" />
            </radialGradient>
          </defs>}
          {tool === "highlighter" ? <path d={highlighterNibPath({ nib: toolStyle.nib, strokeWidth: toolStyle.strokeWidth }, hover, aspectRatio)} fill={activeLayerColor} fillOpacity={Math.min(toolStyle.opacity, .3)} /> : <ellipse
            cx={hover.x * 1000} cy={hover.y * 1000}
            rx={(tool === "eraser" ? ERASER_HIT_RADIUS_PX : 1.25) * 1000 / pageWidth}
            ry={(tool === "eraser" ? ERASER_HIT_RADIUS_PX : 1.25) * 1000 / pageWidth * aspectRatio}
            fill={tool === "eraser" ? `url(#${eraserGradientId})` : activeLayerColor}
            fillOpacity={tool === "eraser" ? .12 : .35}
          />}
        </g>}
      </svg>

      {pageAnnotations.map((annotation) => {
        const payload = annotation.payload;
        if (payload?.kind !== "text" && payload?.kind !== "shape") return null;
        const position = objectTransformPreview?.id === annotation.id
          ? objectTransformPreview.payload
          : payload;
        return (
          <button
            className={payload.kind === "text" ? "annotation-text" : "annotation-shape"}
            aria-label={payload.kind === "shape" ? payload.shape === "rectangle" ? "矩形笔记" : "椭圆笔记" : undefined}
            style={{
              left: `${position.x * 100}%`,
              top: `${position.y * 100}%`,
              color: layerColors.get(annotation.layerId) ?? payload.color ?? "#dc2626",
              ...(position.kind === "text" ? { fontSize: `${position.fontScale * 100}cqw` } : {
                width: `${position.width * 100}%`, height: `${position.height * 100}%`,
              }),
            }}
            data-selected={selectedId === annotation.id && tool === "select" || undefined}
            key={annotation.id}
            disabled={!canMoveObjects || annotation.layerId !== activeLayerId}
            onPointerDown={(event) => beginObjectTransform(event, annotation, payload)}
            onPointerMove={updateObjectTransform}
            onPointerUp={finishObjectTransform}
            onPointerCancel={cancelObjectTransform}
            onKeyDown={(event) => {
              if (tool === "select" && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setSelectedId(annotation.id); }
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
            {payload.kind === "text" ? payload.text : null}
          </button>
        );
      })}

      </div>
      {editing ? createPortal(
        <>
          {canStartEdit && tool === "select" && selected?.payload && <ObjectProperties key={`${selected.id}:${JSON.stringify(selected.payload)}`} payload={selected.payload} personal={!layerColors.has(selected.layerId)} displayColor={layerColors.get(selected.layerId)} onClose={() => setSelectedId(null)} onApply={payload => editor?.persist({ id: selected.id, layerId: selected.layerId, payload }) ?? Promise.resolve(false)} onDelete={() => { void editor?.persist({ id: selected.id, layerId: selected.layerId, payload: null, deleted: true }); setSelectedId(null); }} onEditText={() => {
              const payload = selected.payload;
              if (payload?.kind !== "text") return;
              setSelectedId(null);
              openTextEditor({ id: selected.id, x: payload.x, y: payload.y, initial: payload.text, fontScale: payload.fontScale, pageWidth, source: "existing", color: payload.color });
            }} />}
          {!canStartEdit && !finishing && <aside className="annotation-storage-error" role="status">
            <strong>此层已停止编辑</strong>
            <p>共享层已停用、删除或权限已改变。当前输入可完成并保存在原层的本机草稿中；不会上传或转写其他层。</p>
          </aside>}
          {persistence === "failed" && <aside className="annotation-storage-error" role="alert">
            <strong>本机保存失败</strong>
            <p>修改仍留在当前编辑器，尚未可靠保存。请保留此页面，释放设备空间后重试。</p>
            <button type="button" onClick={() => void editor?.retry()}>重试本机保存</button>
          </aside>}
          <div
            aria-hidden={transformingObject ? undefined : "true"}
            aria-label="拖到这里删除"
            className="annotation-delete-zone"
            data-active={deleteActive || undefined}
            data-visible={transformingObject || undefined}
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
          if (editor?.getSnapshot() === "finishing") return;
          void finishTextEditor();
        }}
        onPointerDown={(event) => {
          backdropReleased.current = false;
          const anchor = openingPoint.current;
          const repeatedOpening = anchor && Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) <= OBJECT_DRAG_THRESHOLD_PX;
          backdropPointer.current = event.target === event.currentTarget && !repeatedOpening ? event.pointerId : null;
          if (event.target !== event.currentTarget) openingPoint.current = null;
        }}
        onPointerUp={(event) => {
          backdropReleased.current = event.target === event.currentTarget && backdropPointer.current === event.pointerId;
          backdropPointer.current = null;
        }}
        onPointerCancel={() => { backdropPointer.current = null; backdropReleased.current = false; }}
        onClick={(event) => {
          const intentional = backdropReleased.current && event.detail <= 1;
          backdropReleased.current = false;
          if (editor?.getSnapshot() !== "finishing" && event.target === event.currentTarget && intentional) void finishTextEditor();
        }}
      >
        <header ref={textComposerHeaderRef}>
          <button
            tabIndex={textEditor ? 0 : -1}
            type="button"
            disabled={textSaving || finishing}
            onClick={cancelTextEditor}
          >
            取消
          </button>
          <button tabIndex={textEditor ? 0 : -1} disabled={textSaving || finishing} type="submit">完成</button>
        </header>
        {textEditor ? (
          <textarea
            aria-label="笔记文本"
            autoFocus
            name="text"
            readOnly={textSaving || finishing}
            ref={textInputRef}
            inputMode="text"
            maxLength={1000}
            rows={2}
            style={{
              color: layerColors.get(activeLayerId ?? "") ?? textEditor.color ?? toolColor,
              fontSize: editorFontSize,
            }}
            value={editorText}
            onChange={(event) => { if (editor?.getSnapshot() === "finishing") return; openingPoint.current = null; setEditorText(event.target.value); }}
            onKeyDown={(event) => {
              if (editor?.getSnapshot() === "finishing") return;
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
            disabled={textSaving || finishing}
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

function ShapePreview({ payload, color }: { payload: Extract<AnnotationPayload, { kind: "shape" }>; color: string }) {
  const props = { fill: "none", stroke: color, strokeWidth: `${payload.strokeWidth * 100}cqw`, vectorEffect: "non-scaling-stroke" };
  return payload.shape === "rectangle"
    ? <rect {...props} x={payload.x * 1000} y={payload.y * 1000} width={payload.width * 1000} height={payload.height * 1000} />
    : <ellipse {...props} cx={(payload.x + payload.width / 2) * 1000} cy={(payload.y + payload.height / 2) * 1000} rx={payload.width * 500} ry={payload.height * 500} />;
}
