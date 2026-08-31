import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useReaderGestures } from "./use-reader-gestures";

describe("useReaderGestures", () => {
  it("keeps the PDF point under the finger midpoint while pinch zooming", () => {
    render(<GestureHarness />);
    const viewport = screen.getByTestId("gesture-viewport");
    mockViewport(viewport);
    viewport.scrollLeft = 100;
    viewport.scrollTop = 50;

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 600, clientY: 200 });

    expect(viewport).toHaveAttribute("data-zoom", "2");
    expect(viewport.scrollLeft).toBeCloseTo(400);
    expect(viewport.scrollTop).toBeCloseTo(300);
  });

  it("allows an under-fit pinch and rebounds to fitted size when released", () => {
    render(<GestureHarness />);
    const viewport = screen.getByTestId("gesture-viewport");
    mockViewport(viewport);

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 300, clientY: 200 });
    expect(viewport).toHaveAttribute("data-zoom", "0.75");

    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(viewport).toHaveAttribute("data-zoom", "1");
  });

  it("keeps an off-center PDF point under the midpoint while pinching under fit", () => {
    render(<GestureHarness />);
    const viewport = screen.getByTestId("gesture-viewport");
    mockViewport(viewport);

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 300, clientY: 200 });

    expect(viewport).toHaveAttribute("data-zoom", "0.75");
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
    expect(viewport.style.getPropertyValue("--reader-pinch-offset-x")).toBe("25px");
    expect(viewport.style.getPropertyValue("--reader-pinch-offset-y")).toBe("50px");
  });
});

function GestureHarness() {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const handlers = useReaderGestures({
    containerRef: ref,
    disabled: false,
    zoom,
    onZoomChange: setZoom,
    onTap: vi.fn(),
  });
  return <div ref={ref} data-testid="gesture-viewport" data-zoom={zoom} {...handlers} />;
}

function mockViewport(element: HTMLElement) {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON: () => ({}),
  });
}
