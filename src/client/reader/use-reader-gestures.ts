import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";

const MIN_PINCH_ZOOM = 0.75;
const MIN_SETTLED_ZOOM = 1;
const MAX_ZOOM = 3;

export function useReaderGestures({
  containerRef,
  disabled,
  zoom,
  onZoomChange,
  onTap,
  onEdgeTap,
  onSwipe,
  panAtFit = false,
}: {
  containerRef: RefObject<HTMLElement | null>;
  disabled: boolean;
  zoom: number;
  onZoomChange(value: number): void;
  onTap(): void;
  onEdgeTap?(direction: "previous" | "next"): void;
  onSwipe?(direction: "previous" | "next"): void;
  panAtFit?: boolean;
}) {
  const points = useRef(new Map<number, { x: number; y: number }>());
  const primary = useRef<{
    id: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const pinch = useRef<{
    distance: number;
    zoom: number;
    contentX: number;
    contentY: number;
  } | null>(null);
  const pendingScroll = useRef<{
    zoom: number;
    left: number;
    top: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const contentOffset = useRef({ x: 0, y: 0 });
  const latestZoom = useRef(zoom);
  const pinched = useRef(false);

  const applyContentOffset = useCallback((x: number, y: number) => {
    contentOffset.current = { x, y };
    const container = containerRef.current;
    if (!container) return;
    container.style.setProperty("--reader-pinch-offset-x", `${x}px`);
    container.style.setProperty("--reader-pinch-offset-y", `${y}px`);
  }, [containerRef]);

  useLayoutEffect(() => {
    latestZoom.current = zoom;
    const pending = pendingScroll.current;
    const container = containerRef.current;
    if (!pending || !container || Math.abs(pending.zoom - zoom) > 0.001) return;
    container.scrollLeft = pending.left;
    container.scrollTop = pending.top;
    applyContentOffset(pending.offsetX, pending.offsetY);
    pendingScroll.current = null;
  }, [applyContentOffset, containerRef, zoom]);

  const pointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
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
    } else if (points.current.size === 2) {
      const [first, second] = [...points.current.values()];
      const bounds = container?.getBoundingClientRect();
      const centerX = (first.x + second.x) / 2 - (bounds?.left ?? 0);
      const centerY = (first.y + second.y) / 2 - (bounds?.top ?? 0);
      pinch.current = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        zoom,
        contentX:
          (container?.scrollLeft ?? 0) + centerX - contentOffset.current.x,
        contentY:
          (container?.scrollTop ?? 0) + centerY - contentOffset.current.y,
      };
      latestZoom.current = zoom;
      pinched.current = true;
    }
  };

  const pointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || !points.current.has(event.pointerId)) return;
    points.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (points.current.size >= 2 && pinch.current) {
      const [first, second] = [...points.current.values()];
      const distance = Math.max(
        1,
        Math.hypot(second.x - first.x, second.y - first.y),
      );
      const nextZoom = clamp(
        pinch.current.zoom * (distance / pinch.current.distance),
        MIN_PINCH_ZOOM,
        MAX_ZOOM,
      );
      const container = containerRef.current;
      const bounds = container?.getBoundingClientRect();
      const centerX = (first.x + second.x) / 2 - (bounds?.left ?? 0);
      const centerY = (first.y + second.y) / 2 - (bounds?.top ?? 0);
      const scale = nextZoom / pinch.current.zoom;
      const horizontalPosition = centerX - pinch.current.contentX * scale;
      const verticalPosition = centerY - pinch.current.contentY * scale;
      pendingScroll.current = {
        zoom: nextZoom,
        left: Math.max(0, -horizontalPosition),
        top: Math.max(0, -verticalPosition),
        offsetX: Math.max(0, horizontalPosition),
        offsetY: Math.max(0, verticalPosition),
      };
      latestZoom.current = nextZoom;
      onZoomChange(nextZoom);
      return;
    }

    const start = primary.current;
    const container = containerRef.current;
    if (!start || !container || start.id !== event.pointerId) return;
    if (zoom > 1 || panAtFit) {
      container.scrollLeft = start.scrollLeft - (event.clientX - start.x);
      container.scrollTop = start.scrollTop - (event.clientY - start.y);
    }
  };

  const finishPinch = () => {
    if (latestZoom.current < MIN_SETTLED_ZOOM) {
      latestZoom.current = MIN_SETTLED_ZOOM;
      pendingScroll.current = null;
      applyContentOffset(0, 0);
      onZoomChange(MIN_SETTLED_ZOOM);
    }
    primary.current = null;
    pinch.current = null;
    pinched.current = false;
  };

  const finishPointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    const start = primary.current;
    const wasPinched = pinched.current;
    points.current.delete(event.pointerId);
    if (points.current.size < 2) pinch.current = null;
    if (wasPinched) {
      if (points.current.size === 0) {
        finishPinch();
      }
      return;
    }
    if (!start || start.id !== event.pointerId) return;
    primary.current = null;
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
    if (
      zoom <= 1 &&
      onSwipe &&
      Math.abs(x) >= 50 &&
      Math.abs(x) > Math.abs(y)
    ) {
      onSwipe(x < 0 ? "next" : "previous");
    }
  };

  const cancelPointer = (event: ReactPointerEvent<HTMLElement>) => {
    points.current.delete(event.pointerId);
    if (points.current.size === 0) {
      if (pinched.current) finishPinch();
      else primary.current = null;
    }
  };

  return {
    onPointerDown: pointerDown,
    onPointerMove: pointerMove,
    onPointerUp: finishPointer,
    onPointerCancel: cancelPointer,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
