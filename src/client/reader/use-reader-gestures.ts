import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from "react";

import type { PageTurnGesture } from "./use-paged-reader";

const MIN_PINCH_ZOOM = 0.75;
const MIN_SETTLED_ZOOM = 1;
const MAX_ZOOM = 3;

type GesturePointer = Pick<ReactPointerEvent<HTMLElement>, "pointerId" | "pointerType" | "clientX" | "clientY" | "timeStamp" | "currentTarget">;

interface Point {
  x: number;
  y: number;
}

interface PinchSession {
  distance: number;
  zoom: number;
  contentBounds: DOMRect;
  contentPoint: Point;
  resolveAnchor?: (zoom: number) => Point;
}

interface PinchPreview {
  zoom: number;
  scale: number;
  offset: Point;
  center: Point;
  contentRatio: Point;
  resolveAnchor?: (zoom: number) => Point;
}

export function useReaderGestures({
  containerRef,
  contentRef,
  previewBoundaryRef,
  disabled,
  zoom,
  onZoomChange,
  onTap,
  onEdgeTap,
  pageTurn,
  pageTurnExtent,
  nativeTouchScroll = false,
  captureAnchor,
}: {
  containerRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  previewBoundaryRef?: RefObject<HTMLElement | null>;
  disabled: boolean;
  zoom: number;
  onZoomChange(value: number): void;
  onTap(): void;
  onEdgeTap?(direction: "previous" | "next"): void;
  pageTurn?: PageTurnGesture;
  pageTurnExtent?: number;
  nativeTouchScroll?: boolean;
  captureAnchor?(center: Point): (zoom: number) => Point;
}) {
  const points = useRef(new Map<number, Point>());
  const primary = useRef<{
    id: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const pinch = useRef<PinchSession | null>(null);
  const preview = useRef<PinchPreview | null>(null);
  const pendingCommit = useRef<PinchPreview | null>(null);
  const previewFrame = useRef<number | null>(null);
  const latestZoom = useRef(zoom);
  const pinched = useRef(false);

  const clearPreview = useCallback(() => {
    previewBoundaryRef?.current?.removeAttribute("data-gesture-preview");
    const content = contentRef.current;
    if (!content) return;
    content.style.removeProperty("--reader-gesture-scale");
    content.style.removeProperty("--reader-gesture-x");
    content.style.removeProperty("--reader-gesture-y");
    content.removeAttribute("data-gesture-preview");
  }, [contentRef, previewBoundaryRef]);

  const paintPreview = useCallback((next: PinchPreview) => {
    const content = contentRef.current;
    if (!content) return;
    previewBoundaryRef?.current?.setAttribute("data-gesture-preview", "");
    content.style.setProperty("--reader-gesture-scale", String(next.scale));
    content.style.setProperty("--reader-gesture-x", `${next.offset.x}px`);
    content.style.setProperty("--reader-gesture-y", `${next.offset.y}px`);
    content.setAttribute("data-gesture-preview", "");
  }, [contentRef, previewBoundaryRef]);

  const schedulePreview = useCallback((next: PinchPreview) => {
    preview.current = next;
    if (previewFrame.current !== null) return;
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = null;
      if (preview.current) paintPreview(preview.current);
    });
  }, [paintPreview]);

  const cancelPreviewFrame = useCallback(() => {
    if (previewFrame.current === null) return;
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = null;
  }, []);

  useLayoutEffect(() => {
    latestZoom.current = zoom;
    const commit = pendingCommit.current;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!commit || !container || !content || Math.abs(commit.zoom - zoom) > 0.001) {
      return;
    }

    clearPreview();
    const bounds = content.getBoundingClientRect();
    const anchor = commit.resolveAnchor?.(zoom);
    const targetX = bounds.left + (anchor?.x ?? bounds.width * commit.contentRatio.x);
    const targetY = bounds.top + (anchor?.y ?? bounds.height * commit.contentRatio.y);
    container.scrollLeft += targetX - commit.center.x;
    container.scrollTop += targetY - commit.center.y;
    pendingCommit.current = null;
    preview.current = null;
  }, [clearPreview, containerRef, contentRef, zoom]);

  useLayoutEffect(
    () => () => {
      cancelPreviewFrame();
      clearPreview();
    },
    [cancelPreviewFrame, clearPreview],
  );

  const pointerDown = (event: GesturePointer) => {
    if (disabled) return;
    if (!(nativeTouchScroll && event.pointerType === "touch")) event.currentTarget.setPointerCapture?.(event.pointerId);
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const container = containerRef.current;
    if (points.current.size === 1) {
      primary.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        scrollLeft: container?.scrollLeft ?? 0,
        scrollTop: container?.scrollTop ?? 0,
      };
      pinched.current = false;
      pageTurn?.begin(pageTurnSample(event, pageTurnExtent));
      return;
    }
    if (points.current.size !== 2) return;
    if (
      primary.current &&
      pageTurn &&
      !pageTurn.cancel(primary.current.id, true)
    ) {
      points.current.clear();
      primary.current = null;
      return;
    }
    const content = contentRef.current;
    if (!content) return;
    const [first, second] = [...points.current.values()];
    const center = midpoint(first, second);
    const contentBounds = content.getBoundingClientRect();
    pinch.current = {
      resolveAnchor: captureAnchor?.(center),
      distance: distance(first, second),
      zoom,
      contentBounds,
      contentPoint: {
        x: center.x - contentBounds.left,
        y: center.y - contentBounds.top,
      },
    };
    latestZoom.current = zoom;
    pinched.current = true;
    previewBoundaryRef?.current?.setAttribute("data-gesture-preview", "");
  };

  const pointerMove = (event: GesturePointer) => {
    if (disabled || !points.current.has(event.pointerId)) return;
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size >= 2 && pinch.current) {
      const [first, second] = [...points.current.values()];
      const center = midpoint(first, second);
      const nextZoom = clamp(
        pinch.current.zoom * (distance(first, second) / pinch.current.distance),
        MIN_PINCH_ZOOM,
        MAX_ZOOM,
      );
      const scale = nextZoom / pinch.current.zoom;
      const next: PinchPreview = {
        resolveAnchor: pinch.current.resolveAnchor,
        zoom: nextZoom,
        scale,
        offset: {
          x:
            center.x -
            pinch.current.contentBounds.left -
            pinch.current.contentPoint.x * scale,
          y:
            center.y -
            pinch.current.contentBounds.top -
            pinch.current.contentPoint.y * scale,
        },
        center,
        contentRatio: {
          x: clamp(
            pinch.current.contentPoint.x / Math.max(1, pinch.current.contentBounds.width),
            0,
            1,
          ),
          y: clamp(
            pinch.current.contentPoint.y / Math.max(1, pinch.current.contentBounds.height),
            0,
            1,
          ),
        },
      };
      latestZoom.current = nextZoom;
      schedulePreview(next);
      return;
    }

    const start = primary.current;
    const container = containerRef.current;
    if (!start || !container || start.id !== event.pointerId) return;
    if (zoom <= 1 && pageTurn?.move(pageTurnSample(event, pageTurnExtent))) {
      return;
    }
    if ((zoom > 1 || nativeTouchScroll) && !(nativeTouchScroll && event.pointerType === "touch")) {
      container.scrollLeft = start.scrollLeft - (event.clientX - start.x);
      container.scrollTop = start.scrollTop - (event.clientY - start.y);
    }
  };

  const resetGesture = () => {
    primary.current = null;
    pinch.current = null;
    pinched.current = false;
  };

  const finishPinch = () => {
    cancelPreviewFrame();
    const lastPreview = preview.current;
    const settledZoom = clamp(latestZoom.current, MIN_SETTLED_ZOOM, MAX_ZOOM);
    if (!lastPreview || Math.abs(settledZoom - zoom) < 0.001) {
      pendingCommit.current = null;
      preview.current = null;
      clearPreview();
      resetGesture();
      return;
    }
    const commit = {
      ...lastPreview,
      zoom: settledZoom,
      scale: settledZoom / (pinch.current?.zoom ?? zoom),
    };
    paintPreview(commit);
    pendingCommit.current = commit;
    onZoomChange(settledZoom);
    resetGesture();
  };

  const finishPointer = (event: GesturePointer) => {
    if (disabled) return;
    const start = primary.current;
    const wasPinched = pinched.current;
    points.current.delete(event.pointerId);
    if (points.current.size < 2) pinch.current = null;
    if (wasPinched) {
      if (points.current.size === 0) finishPinch();
      return;
    }
    if (!start || start.id !== event.pointerId) return;
    primary.current = null;
    if (zoom <= 1 && pageTurn?.end(pageTurnSample(event, pageTurnExtent))) {
      return;
    }
    const x = event.clientX - start.x;
    const y = event.clientY - start.y;
    if (Math.abs(x) < 10 && Math.abs(y) < 10) {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && onEdgeTap) {
        const edgeWidth = Math.min(bounds.width * 0.18, 144);
        const relativeX = start.x - bounds.left;
        if (relativeX <= edgeWidth) {
          onEdgeTap("previous");
          return;
        }
        if (relativeX >= bounds.width - edgeWidth) {
          onEdgeTap("next");
          return;
        }
      }
      onTap();
      return;
    }
  };

  const cancelPointer = (event: GesturePointer) => {
    points.current.delete(event.pointerId);
    pageTurn?.cancel(event.pointerId);
    if (pinched.current) {
      points.current.clear();
      cancelPreviewFrame();
      pendingCommit.current = null;
      preview.current = null;
      clearPreview();
      resetGesture();
    } else if (points.current.size === 0) {
      primary.current = null;
    }
  };

  // Native scrolling owns single-touch movement and momentum. Only a pinch
  // cancels the default touch action; both input paths share the zoom state.
  const handleTouch = useEffectEvent((event: TouchEvent) => {
    if (disabled) return;
    if ((event.touches.length >= 2 || pinched.current) && event.cancelable) event.preventDefault();
    const target = containerRef.current;
    if (!target) return;
    for (const touch of Array.from(event.changedTouches)) {
      const sample: GesturePointer = {
        pointerId: touch.identifier, pointerType: "touch",
        clientX: touch.clientX, clientY: touch.clientY,
        timeStamp: event.timeStamp, currentTarget: target,
      };
      if (event.type === "touchstart") pointerDown(sample);
      else if (event.type === "touchmove") pointerMove(sample);
      else if (event.type === "touchend") finishPointer(sample);
      else cancelPointer(sample);
    }
  });
  useEffect(() => {
    const target = containerRef.current;
    if (!nativeTouchScroll || !target) return;
    const listener = (event: TouchEvent) => handleTouch(event);
    const types = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;
    for (const type of types) target.addEventListener(type, listener, { passive: false });
    return () => { for (const type of types) target.removeEventListener(type, listener); };
  }, [containerRef, nativeTouchScroll]);

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => { if (!(nativeTouchScroll && event.pointerType === "touch")) pointerDown(event); },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => { if (!(nativeTouchScroll && event.pointerType === "touch")) pointerMove(event); },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => { if (!(nativeTouchScroll && event.pointerType === "touch")) finishPointer(event); },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => { if (!(nativeTouchScroll && event.pointerType === "touch")) cancelPointer(event); },
  };
}

function pageTurnSample(
  event: GesturePointer,
  extent?: number,
) {
  return {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    time: event.timeStamp,
    extent: Math.max(
      1,
      extent ?? event.currentTarget.getBoundingClientRect().width,
    ),
  };
}

function midpoint(first: Point, second: Point) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance(first: Point, second: Point) {
  return Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
