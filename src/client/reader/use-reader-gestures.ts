import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useRef,
} from "react";

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
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const pinched = useRef(false);

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
      pinch.current = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        zoom,
      };
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
      onZoomChange(
        clamp(pinch.current.zoom * (distance / pinch.current.distance), 1, 3),
      );
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

  const finishPointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (disabled) return;
    const start = primary.current;
    const wasPinched = pinched.current;
    points.current.delete(event.pointerId);
    if (points.current.size < 2) pinch.current = null;
    if (wasPinched) {
      if (points.current.size === 0) {
        primary.current = null;
        pinched.current = false;
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
      primary.current = null;
      pinch.current = null;
      pinched.current = false;
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
