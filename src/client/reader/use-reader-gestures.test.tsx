import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReaderGestures } from "./use-reader-gestures";

let nextFrameId = 1;
let frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  nextFrameId = 1;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useReaderGestures", () => {
  it("previews around the midpoint and commits one settled zoom", () => {
    const onZoomChange = vi.fn();
    render(<GestureHarness onZoomChange={onZoomChange} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    mockGeometry(viewport, content);
    viewport.scrollLeft = 100;
    viewport.scrollTop = 50;

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 600, clientY: 200 });
    flushAnimationFrame();

    expect(viewport).toHaveAttribute("data-zoom", "1");
    expect(content.style.getPropertyValue("--reader-gesture-scale")).toBe("2");
    expect(content.style.getPropertyValue("--reader-gesture-x")).toBe("-300px");
    expect(content.style.getPropertyValue("--reader-gesture-y")).toBe("-250px");
    expect(onZoomChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 600, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 200 });

    expect(viewport).toHaveAttribute("data-zoom", "2");
    expect(viewport.scrollLeft).toBeCloseTo(400);
    expect(viewport.scrollTop).toBeCloseTo(300);
    expect(onZoomChange).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveAttribute("data-gesture-preview");
  });

  it("coalesces 60 pointer samples into one composited preview and one commit", () => {
    const onZoomChange = vi.fn();
    render(<GestureHarness onZoomChange={onZoomChange} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    mockGeometry(viewport, content);

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    for (let index = 0; index < 60; index += 1) {
      fireEvent.pointerMove(viewport, {
        pointerId: 2,
        clientX: 401 + index,
        clientY: 200,
      });
    }

    expect(frames.size).toBe(1);
    expect(onZoomChange).not.toHaveBeenCalled();
    flushAnimationFrame();
    expect(content).toHaveAttribute("data-gesture-preview");

    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 460, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(onZoomChange).toHaveBeenCalledTimes(1);
  });

  it("allows an under-fit preview and rebounds without a redundant render", () => {
    const onZoomChange = vi.fn();
    render(<GestureHarness onZoomChange={onZoomChange} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    mockGeometry(viewport, content);

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 300, clientY: 200 });
    flushAnimationFrame();
    expect(content.style.getPropertyValue("--reader-gesture-scale")).toBe("0.75");
    expect(content.style.getPropertyValue("--reader-gesture-x")).toBe("25px");
    expect(content.style.getPropertyValue("--reader-gesture-y")).toBe("50px");

    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(viewport).toHaveAttribute("data-zoom", "1");
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(content).not.toHaveAttribute("data-gesture-preview");
  });

  it("discards a cancelled preview without changing committed zoom", () => {
    const onZoomChange = vi.fn();
    render(<GestureHarness onZoomChange={onZoomChange} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    mockGeometry(viewport, content);

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 500, clientY: 200 });
    flushAnimationFrame();
    expect(content).toHaveAttribute("data-gesture-preview");

    fireEvent.pointerCancel(viewport, { pointerId: 2 });
    expect(content).not.toHaveAttribute("data-gesture-preview");
    expect(viewport).toHaveAttribute("data-zoom", "1");
    expect(onZoomChange).not.toHaveBeenCalled();
  });
});

function GestureHarness({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const handlers = useReaderGestures({
    containerRef,
    contentRef,
    disabled: false,
    zoom,
    onZoomChange: (value) => {
      onZoomChange(value);
      setZoom(value);
    },
    onTap: vi.fn(),
  });
  return (
    <div
      ref={containerRef}
      data-testid="gesture-viewport"
      data-zoom={zoom}
      {...handlers}
    >
      <div ref={contentRef} data-testid="gesture-content" />
    </div>
  );
}

function mockGeometry(viewport: HTMLElement, content: HTMLElement) {
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => rect(0, 0, 1000, 800));
  vi.spyOn(content, "getBoundingClientRect").mockImplementation(() => {
    const zoom = Number(viewport.dataset.zoom ?? 1);
    return rect(-viewport.scrollLeft, -viewport.scrollTop, 1000 * zoom, 800 * zoom);
  });
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function flushAnimationFrame() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(performance.now());
}
