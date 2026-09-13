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
  twoFingerOnly = false,
  minimumZoom = 1,
  zoom,
  onZoomChange,
  onTap,
  onEdgeTap,
  pageTurn,
  pageTurnExtent,
  nativeTouchScroll = false,
  captureAnchor,
  constrainScroll,
  onNavigationStart,
  isObjectGestureActive,
}: {
  containerRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  previewBoundaryRef?: RefObject<HTMLElement | null>;
  disabled: boolean;
  twoFingerOnly?: boolean;
  minimumZoom?: number;
  zoom: number;
  onZoomChange(value: number): void;
  onTap(): void;
  onEdgeTap?(direction: "previous" | "next"): void;
  pageTurn?: PageTurnGesture;
  pageTurnExtent?: number;
  nativeTouchScroll?: boolean;
  constrainScroll?(): void;
  onNavigationStart?(): void;
  isObjectGestureActive?(): boolean;
  captureAnchor?(center: Point): (zoom: number) => Point;
}) {
  const constrain = useEffectEvent(() => constrainScroll?.());
  const objectPointers = useRef(new Set<number>());
  const points = useRef(new Map<number, Point>());
  const primary = useRef<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  const pinch = useRef<PinchSession | null>(null);
  const preview = useRef<PinchPreview | null>(null);
  const pendingCommit = useRef<PinchPreview | null>(null);
  const latestZoom = useRef(zoom);
  const pinched = useRef(false);
  const navigation = useRef<{ origin: Point; left: number; right: number; scrollLeft: number; scrollTop: number; extent: number } | null>(null);
  const scaled = useRef(false);
  const drained = useRef(false);
  const nativeAxis = useRef<"pending" | "horizontal" | "vertical">("pending");
  const pairFrame = useRef<number | null>(null);
  const pairTime = useRef(0);
  const beginNavigation = (center: Point, time: number) => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const paper = content.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    const extent = pageTurnExtent ?? viewport.width;
    navigation.current = { origin: center, left: Math.max(0, viewport.left - paper.left),
      right: Math.max(0, paper.right - viewport.right), scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop, extent };
    pageTurn?.begin({ sessionId: 0, x: 0, y: 0, time, extent });
  };
  const moveNavigation = (center: Point, time: number, nativeVertical = false) => {
    const session = navigation.current;
    const container = containerRef.current;
    if (!session || !container) return;
    const dx = center.x - session.origin.x;
    const dy = center.y - session.origin.y;
    const pan = clamp(dx, -session.right, session.left);
    container.scrollLeft = session.scrollLeft - pan;
    if (!nativeVertical) container.scrollTop = session.scrollTop - dy;
    constrainScroll?.();
    const remaining = dx - pan;
    // Rebase while inside the paper: neither pan distance nor its velocity
    // enters the pager, including after reversing a partial page turn.
    if (remaining === 0) {
      pageTurn?.cancel(0, true);
      pageTurn?.begin({ sessionId: 0, x: 0, y: 0, time, extent: session.extent });
    } else {
      pageTurn?.move({ sessionId: 0, x: remaining, y: Math.abs(dx) > Math.abs(dy) ? 0 : dy, time, extent: session.extent });
    }
  };

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

  const cancelPairFrame = useCallback(() => {
    if (pairFrame.current === null) return;
    cancelAnimationFrame(pairFrame.current);
    pairFrame.current = null;
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
    constrain();
    pendingCommit.current = null;
    preview.current = null;
  }, [clearPreview, containerRef, contentRef, zoom]);

  useLayoutEffect(
    () => () => {
      cancelPairFrame();
      clearPreview();
    },
    [cancelPairFrame, clearPreview],
  );

  useLayoutEffect(() => {
    cancelPairFrame();
    clearPreview();
    navigation.current = null;
    pinch.current = null;
    preview.current = null;
    pendingCommit.current = null;
    drained.current = points.current.size > 0;
  }, [pageTurn, disabled, cancelPairFrame, clearPreview]);

  const pointerDown = (event: GesturePointer) => {
    if (disabled || (twoFingerOnly && event.pointerType !== "touch")) return;
    if (!twoFingerOnly && !(nativeTouchScroll && event.pointerType === "touch")) {
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* The browser may already have retired this pointer. */ }
    }
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (drained.current) return;
    if (points.current.size === 1) {
      primary.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      pinched.current = false;
      scaled.current = false;
      nativeAxis.current = "pending";
      if (!twoFingerOnly) beginNavigation({ x: event.clientX, y: event.clientY }, event.timeStamp);
      return;
    }
    if (points.current.size > 2) {
      pageTurn?.cancel(0, true);
      drained.current = true;
      cancelPairFrame(); clearPreview(); preview.current = null;
      return;
    }
    if (points.current.size !== 2) return;
    if (nativeAxis.current === "vertical") { drained.current = true; return; }
    if (!twoFingerOnly && pageTurn && !pageTurn.cancel(0, true)) { drained.current = true; return; }
    const content = contentRef.current;
    if (!content) return;
    if (twoFingerOnly) onNavigationStart?.();
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
    beginNavigation(center, event.timeStamp);
    latestZoom.current = zoom;
    pinched.current = true;
  };

  const samplePair = (time: number) => {
    if (drained.current || points.current.size !== 2 || !pinch.current) return;
    const [first, second] = [...points.current.values()];
    const center = midpoint(first, second);
    if (pageTurn && !scaled.current && Math.abs(distance(first, second) / pinch.current.distance - 1) <= 0.08) {
      moveNavigation(center, time);
      return;
    }
    scaled.current = true;
    pageTurn?.cancel(0, true);
    const nextZoom = clamp(
      pinch.current.zoom * (distance(first, second) / pinch.current.distance),
      Math.min(MIN_PINCH_ZOOM, minimumZoom * 0.75),
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
    preview.current = next;
    paintPreview(next);
  };

  const flushPair = () => {
    if (pairFrame.current !== null) cancelAnimationFrame(pairFrame.current);
    pairFrame.current = null;
    samplePair(pairTime.current);
  };
  const pointerMove = (event: GesturePointer) => {
    if (disabled || !points.current.has(event.pointerId) || drained.current) return;
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size === 2 && pinch.current) {
      pairTime.current = event.timeStamp;
      if (pairFrame.current === null) pairFrame.current = requestAnimationFrame(() => {
        pairFrame.current = null;
        samplePair(pairTime.current);
      });
      return;
    }
    if (twoFingerOnly || pinched.current || nativeAxis.current === "vertical") return;
    moveNavigation({ x: event.clientX, y: event.clientY }, event.timeStamp,
      nativeTouchScroll && event.pointerType === "touch");
  };

  const resetGesture = () => {
    primary.current = null;
    pinch.current = null;
    pinched.current = false;
    navigation.current = null;
    drained.current = false;
    nativeAxis.current = "pending";
  };

  const finishPinch = () => {
    cancelPairFrame();
    const lastPreview = preview.current;
    const settledZoom = clamp(latestZoom.current, minimumZoom, MAX_ZOOM);
    if (lastPreview && Math.abs(settledZoom - zoom) < 0.001) {
      clearPreview();
      const container = containerRef.current;
      const bounds = contentRef.current?.getBoundingClientRect();
      if (container && bounds) {
        const anchor = lastPreview.resolveAnchor?.(zoom);
        container.scrollLeft += bounds.left + (anchor?.x ?? bounds.width * lastPreview.contentRatio.x) - lastPreview.center.x;
        container.scrollTop += bounds.top + (anchor?.y ?? bounds.height * lastPreview.contentRatio.y) - lastPreview.center.y;
      }
    }
    if (!lastPreview || Math.abs(settledZoom - zoom) < 0.001) {
      constrainScroll?.();
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
    if (wasPinched && points.current.size === 2 && pairFrame.current !== null) flushPair();
    points.current.delete(event.pointerId);
    if (drained.current) {
      if (points.current.size === 0) resetGesture();
      return;
    }
    if (wasPinched) {
      if (points.current.size === 1 && pageTurn && !scaled.current) {
        pageTurn.end({ sessionId: 0, x: 0, y: 0, time: event.timeStamp, extent: pageTurnExtent ?? 1 });
        drained.current = true;
      } else if (points.current.size === 0) finishPinch();
      return;
    }
    if (twoFingerOnly || !start || start.id !== event.pointerId) return;
    primary.current = null;
    if (pageTurn?.end({ sessionId: 0, x: 0, y: 0, time: event.timeStamp, extent: pageTurnExtent ?? 1 })) {
      return;
    }
    const x = event.clientX - start.x;
    const y = event.clientY - start.y;
    if (Math.abs(x) < 10 && Math.abs(y) < 10) {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && onEdgeTap) {
        const edgeWidth = bounds.width / 3;
        const relativeX = start.x - bounds.left;
        if (relativeX < edgeWidth) {
          onEdgeTap("previous");
          return;
        }
        if (relativeX >= bounds.width * 2 / 3) {
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
    pageTurn?.cancel(0);
    if (pairFrame.current !== null) cancelAnimationFrame(pairFrame.current);
    pairFrame.current = null;
    if (pinched.current) {
      drained.current = points.current.size > 0;
      cancelPairFrame();
      pendingCommit.current = null;
      preview.current = null;
      clearPreview();
      if (points.current.size === 0) resetGesture();
    } else if (points.current.size === 0) {
      primary.current = null;
    }
  };

  // Native scrolling owns single-touch movement and momentum. Only a pinch
  // cancels the default touch action; both input paths share the zoom state.
  const handleTouch = useEffectEvent((event: TouchEvent) => {
    if (disabled) return;
    if (event.type === "touchmove" && event.touches.length === 1 && primary.current && nativeAxis.current === "pending") {
      const touch = event.touches[0];
      const dx = Math.abs(touch.clientX - primary.current.x);
      const dy = Math.abs(touch.clientY - primary.current.y);
      if (Math.max(dx, dy) >= 8) nativeAxis.current = dx > dy ? "horizontal" : "vertical";
    }
    if (nativeAxis.current !== "vertical" && (event.touches.length >= 2 || pinched.current || nativeAxis.current === "horizontal") && event.cancelable) event.preventDefault();
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

  const capture = (event: ReactPointerEvent<HTMLElement>, handle: (event: GesturePointer) => void) => {
    if (!twoFingerOnly || event.pointerType !== "touch" || !event.currentTarget.contains(event.target as Node)) return;
    // The child claims an object on its first pointerdown (after capture).
    // Keep that ownership through all releases, even if a cancellation clears
    // the child's transform before the other fingers leave the screen.
    const objectActive = isObjectGestureActive?.() ?? false;
    if (objectPointers.current.size > 0 || objectActive) {
      pageTurn?.cancel(0, true);
      cancelPairFrame(); clearPreview();
      for (const id of points.current.keys()) objectPointers.current.add(id);
      points.current.clear();
      primary.current = null;
      if (event.type === "pointerup" || event.type === "pointercancel") objectPointers.current.delete(event.pointerId);
      else objectPointers.current.add(event.pointerId);
      // A cancelled child no longer owns these events. Drain the sequence
      // without letting a remaining/new finger start a fresh note.
      if (!objectActive) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const suppress = drained.current || pinched.current || points.current.size >= 2;
    handle(event);
    if (suppress || pinched.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return {
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => capture(event, pointerDown),
    onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => capture(event, pointerMove),
    onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => capture(event, finishPointer),
    onPointerCancelCapture: (event: ReactPointerEvent<HTMLElement>) => capture(event, cancelPointer),
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => { if (!twoFingerOnly && !(nativeTouchScroll && event.pointerType === "touch")) pointerDown(event); },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => { if (!twoFingerOnly && !(nativeTouchScroll && event.pointerType === "touch")) pointerMove(event); },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => { if (!twoFingerOnly && !(nativeTouchScroll && event.pointerType === "touch")) finishPointer(event); },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => { if (!twoFingerOnly && !(nativeTouchScroll && event.pointerType === "touch")) cancelPointer(event); },
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
