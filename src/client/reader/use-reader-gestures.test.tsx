import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReaderGestures } from "./use-reader-gestures";
import { PdfPageCanvas } from "./pdf-page";
import type { PDFDocumentProxy } from "./pdf-document";
import type { PageTurnGesture } from "./use-paged-reader";

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
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useReaderGestures", () => {
  it.each(["turn", "cancel", "pinch"] as const)("shares two-finger %s with the pager using a combined frame", kind => {
    const pageTurn: PageTurnGesture = { begin: vi.fn(), move: vi.fn(() => true), end: vi.fn(() => true), cancel: vi.fn(() => true) };
    render(<GestureHarness onZoomChange={vi.fn()} pageTurn={pageTurn} twoFingerOnly />);
    const viewport = screen.getByTestId("gesture-viewport");
    mockGeometry(viewport, screen.getByTestId("gesture-content"));
    const sample = (pointerId: number, clientX: number) => ({ pointerId, clientX, clientY: 200, pointerType: "touch" });
    fireEvent.pointerDown(viewport, sample(1, 300));
    fireEvent.pointerDown(viewport, sample(2, 400));
    fireEvent.pointerMove(viewport, sample(1, 200));
    fireEvent.pointerMove(viewport, sample(2, kind === "pinch" ? 400 : 300));
    flushAnimationFrame();
    expect(pageTurn.move).toHaveBeenCalledTimes(kind === "pinch" ? 0 : 1);
    if (kind === "cancel") fireEvent.pointerCancel(viewport, sample(1, 200));
    else fireEvent.pointerUp(viewport, sample(1, 200));
    fireEvent.pointerUp(viewport, sample(2, 300));
    expect(pageTurn.end).toHaveBeenCalledTimes(kind === "turn" ? 1 : 0);
  });

  it.each(["move", "up", "cancel"] as const)("ignores mouse %s with the same numeric id as an active native touch", phase => {
    const pageTurn: PageTurnGesture = { begin: vi.fn(), move: vi.fn(() => true), end: vi.fn(() => true), cancel: vi.fn(() => true) };
    render(<GestureHarness onZoomChange={vi.fn()} pageTurn={pageTurn} nativeTouchScroll />);
    const viewport = screen.getByTestId("gesture-viewport");
    mockGeometry(viewport, screen.getByTestId("gesture-content"));
    const touch = (clientX: number) => ({ identifier: 1, clientX, clientY: 200, target: viewport });
    fireEvent.touchStart(viewport, { touches: [touch(500)], changedTouches: [touch(500)] });
    const mouse = { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 200 };
    if (phase === "move") fireEvent.pointerMove(viewport, mouse);
    else if (phase === "up") fireEvent.pointerUp(viewport, mouse);
    else fireEvent.pointerCancel(viewport, mouse);
    expect(pageTurn.move).not.toHaveBeenCalled();
    expect(pageTurn.end).not.toHaveBeenCalled();
    expect(pageTurn.cancel).not.toHaveBeenCalled();
    fireEvent.touchMove(viewport, { touches: [touch(300)], changedTouches: [touch(300)] });
    expect(pageTurn.move).toHaveBeenCalledWith(expect.objectContaining({ x: -200 }));
    fireEvent.touchEnd(viewport, { touches: [], changedTouches: [touch(300)] });
    expect(pageTurn.end).toHaveBeenCalledOnce();
  });

  it("previews around the midpoint and commits one settled zoom", () => {
    const onZoomChange = vi.fn();
    render(<GestureHarness onZoomChange={onZoomChange} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    const boundary = screen.getByTestId("gesture-boundary");
    mockGeometry(viewport, content);
    viewport.scrollLeft = 100;
    viewport.scrollTop = 50;

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 600, clientY: 200 });
    flushAnimationFrame();

    expect(viewport).toHaveAttribute("data-zoom", "1");
    expect(boundary).toHaveAttribute("data-gesture-preview");
    expect(onZoomChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 600, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 200 });

    expect(viewport).toHaveAttribute("data-zoom", "2");
    expect(viewport.scrollLeft).toBeCloseTo(400);
    expect(viewport.scrollTop).toBeCloseTo(300);
    expect(onZoomChange).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveAttribute("data-gesture-preview");
    expect(boundary).not.toHaveAttribute("data-gesture-preview");
  });

  it("commits translation when two fingers move without changing scale", () => {
    render(<GestureHarness onZoomChange={vi.fn()} />);
    const viewport = screen.getByTestId("gesture-viewport");
    mockGeometry(viewport, screen.getByTestId("gesture-content"));
    viewport.scrollTop = 150;
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 200, clientY: 250 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 400, clientY: 250 });
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 400, clientY: 250 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 250 });
    expect(viewport.scrollTop).toBe(200);
  });

  it("does not begin a pinch while an uncancellable page transition is active", () => {
    const pageTurn: PageTurnGesture = {
      begin: vi.fn(),
      move: vi.fn(() => false),
      end: vi.fn(() => false),
      cancel: vi.fn(() => false),
    };
    render(<GestureHarness onZoomChange={vi.fn()} pageTurn={pageTurn} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const boundary = screen.getByTestId("gesture-boundary");

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 600, clientY: 200 });

    expect(pageTurn.cancel).toHaveBeenCalledWith(0, true);
    expect(boundary).not.toHaveAttribute("data-gesture-preview");
    expect(frames).toHaveLength(0);
  });

  it("coalesces 60 pointer samples into one preview and one bounded PDF redraw", async () => {
    const onZoomChange = vi.fn();
    const renderPage = vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }));
    const document = {
      getPage: vi.fn().mockResolvedValue({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: renderPage,
      }),
    } as unknown as PDFDocumentProxy;
    render(
      <RenderingGestureHarness document={document} onZoomChange={onZoomChange} />,
    );
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    mockGeometry(viewport, content);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    // Ignore any initial PDF layout frame; this assertion scopes the frame
    // count to the pointer burst below.
    frames.clear();

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
    expect(renderPage).toHaveBeenCalledTimes(1);
    flushAnimationFrame();
    expect(content).toHaveAttribute("data-gesture-preview");

    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: 460, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 200, clientY: 200 });
    expect(onZoomChange).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
  });

  it.each([
    {
      name: "center with existing scroll",
      first: 100,
      second: 300,
      moved: 500,
      initialScroll: 100,
      expectedScroll: 300,
    },
    {
      name: "left edge",
      first: 0,
      second: 100,
      moved: 200,
      initialScroll: 0,
      expectedScroll: 0,
    },
    {
      name: "right edge",
      first: 500,
      second: 600,
      moved: 700,
      initialScroll: 0,
      expectedScroll: 500,
    },
  ])("commits $name geometry before a delayed PDF redraw", async ({
    first,
    second,
    moved,
    initialScroll,
    expectedScroll,
  }) => {
    let finishRedraw: (() => void) | undefined;
    const redraw = new Promise<void>((resolve) => {
      finishRedraw = resolve;
    });
    const renderPage = vi
      .fn()
      .mockReturnValueOnce({ promise: Promise.resolve(), cancel: vi.fn() })
      .mockReturnValueOnce({ promise: redraw, cancel: vi.fn() });
    const document = {
      getPage: vi.fn().mockResolvedValue({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: renderPage,
      }),
    } as unknown as PDFDocumentProxy;
    render(
      <RenderingGestureHarness document={document} onZoomChange={vi.fn()} />,
    );
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() =>
      rect(0, 0, 1000, 800),
    );
    vi
      .spyOn(content, "getBoundingClientRect")
      .mockImplementation(() => {
        const page = content.querySelector<HTMLElement>(".pdf-page-canvas");
        return rect(
          -viewport.scrollLeft,
          -viewport.scrollTop,
          Number.parseFloat(page?.style.width ?? "0"),
          Number.parseFloat(page?.style.height ?? "0"),
        );
      });
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(content.querySelector("[data-pdf-canvas-active]")).not.toBeNull(),
    );
    const firstCanvas = content.querySelector("[data-pdf-canvas-active]");
    viewport.scrollLeft = initialScroll;

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: first, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: second, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: moved, clientY: 200 });
    flushAnimationFrame();
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: moved, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: first, clientY: 200 });

    expect(content.querySelector<HTMLElement>(".pdf-page-canvas")?.style.width).toBe(
      "1200px",
    );
    expect(viewport.scrollLeft).toBeCloseTo(expectedScroll);
    expect(content.querySelector("[data-pdf-canvas-active]")).toBe(firstCanvas);
    await waitFor(() => expect(renderPage).toHaveBeenCalledTimes(2));
    const settledWidth = content.querySelector<HTMLElement>(".pdf-page-canvas")?.style.width;
    const settledScrollLeft = viewport.scrollLeft;
    const settledScrollTop = viewport.scrollTop;
    const settledBounds = content.getBoundingClientRect();

    finishRedraw?.();
    await waitFor(() =>
      expect(content.querySelector("[data-pdf-canvas-active]")).not.toBe(firstCanvas),
    );
    expect((firstCanvas as HTMLCanvasElement).width).toBe(1);
    expect(content.querySelector<HTMLElement>(".pdf-page-canvas")?.style.width).toBe(
      settledWidth,
    );
    expect(viewport.scrollLeft).toBeCloseTo(settledScrollLeft);
    expect(viewport.scrollTop).toBeCloseTo(settledScrollTop);
    expect(content.getBoundingClientRect()).toMatchObject({
      left: settledBounds.left,
      top: settledBounds.top,
      width: settledBounds.width,
      height: settledBounds.height,
    });
  });

  it.each([
    { name: "left edge", first: 20, second: 120, moved: 220, scrollLeft: 20 },
    { name: "right edge", first: 800, second: 900, moved: 1000, scrollLeft: 800 },
  ])("keeps the anchored PDF point stable at the $name", ({ first, second, moved, scrollLeft }) => {
    render(<GestureHarness onZoomChange={vi.fn()} />);
    const viewport = screen.getByTestId("gesture-viewport");
    const content = screen.getByTestId("gesture-content");
    mockGeometry(viewport, content);

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: first, clientY: 200 });
    fireEvent.pointerDown(viewport, { pointerId: 2, clientX: second, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 2, clientX: moved, clientY: 200 });
    flushAnimationFrame();
    fireEvent.pointerUp(viewport, { pointerId: 2, clientX: moved, clientY: 200 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: first, clientY: 200 });

    expect(viewport.scrollLeft).toBeCloseTo(scrollLeft);
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

function GestureHarness({
  onZoomChange,
  pageTurn,
  twoFingerOnly = false,
  nativeTouchScroll = false,
}: {
  onZoomChange: (zoom: number) => void;
  pageTurn?: PageTurnGesture;
  twoFingerOnly?: boolean;
  nativeTouchScroll?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previewBoundaryRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const handlers = useReaderGestures({
    containerRef,
    contentRef,
    previewBoundaryRef,
    disabled: false,
    twoFingerOnly,
    nativeTouchScroll,
    zoom,
    onZoomChange: (value) => {
      onZoomChange(value);
      setZoom(value);
    },
    onTap: vi.fn(),
    pageTurn,
  });
  return (
    <div
      ref={containerRef}
      data-testid="gesture-viewport"
      data-zoom={zoom}
      {...handlers}
    >
      <div ref={previewBoundaryRef} data-testid="gesture-boundary">
        <div ref={contentRef} data-testid="gesture-content"><button className="annotation-text">对象</button></div>
      </div>
    </div>
  );
}

function RenderingGestureHarness({
  document,
  onZoomChange,
}: {
  document: PDFDocumentProxy;
  onZoomChange: (zoom: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previewBoundaryRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const handlers = useReaderGestures({
    containerRef,
    contentRef,
    previewBoundaryRef,
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
      <div ref={previewBoundaryRef} data-testid="gesture-boundary">
        <div ref={contentRef} data-testid="gesture-content">
          <PdfPageCanvas document={document} pageNumber={1} width={600 * zoom} />
        </div>
      </div>
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


it.each([600, 1200, 1500])("divides a %ipx viewport into three equal tap zones", width => {
  const tap = vi.fn();
  const edge = vi.fn();
  function TapHarness() {
    const ref = useRef<HTMLDivElement>(null);
    const handlers = useReaderGestures({ containerRef: ref, contentRef: ref, disabled: false, zoom: 1, onZoomChange: vi.fn(), onTap: tap, onEdgeTap: edge });
    return <div ref={ref} data-testid="tap-zones" {...handlers} />;
  }
  render(<TapHarness />);
  const viewport = screen.getByTestId("tap-zones");
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(50, 0, width, 700));
  for (const [x, expected] of [[width / 3 - 1, "previous"], [width / 3, "chrome"], [width * 2 / 3 - 1, "chrome"], [width * 2 / 3, "next"]] as const) {
    tap.mockClear(); edge.mockClear();
    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 50 + x, clientY: 100 });
    fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 50 + x, clientY: 100 });
    if (expected === "chrome") { expect(tap).toHaveBeenCalledOnce(); expect(edge).not.toHaveBeenCalled(); }
    else { expect(edge).toHaveBeenCalledWith(expected); expect(tap).not.toHaveBeenCalled(); }
  }
});

it("keeps a cancelled object sequence out of viewport navigation until all fingers leave", () => {
  const zoom = vi.fn();
  const navigate = vi.fn();
  function OwnershipHarness() {
    const ref = useRef<HTMLDivElement>(null);
    const active = useRef(false);
    const handlers = useReaderGestures({ containerRef: ref, contentRef: ref, disabled: false, twoFingerOnly: true, zoom: 1, onZoomChange: zoom, onTap: vi.fn(), onNavigationStart: navigate, isObjectGestureActive: () => active.current });
    return <div ref={ref} data-testid="owner" {...handlers}><button onPointerDown={() => { active.current = true; }} onPointerCancel={() => { active.current = false; }}>object</button></div>;
  }
  render(<OwnershipHarness />);
  const viewport = screen.getByTestId("owner");
  const object = screen.getByRole("button", { name: "object" });
  const sample = (pointerId: number, clientX = 200) => ({ pointerId, pointerType: "touch", clientX, clientY: 200 });
  fireEvent.pointerDown(object, sample(1));
  fireEvent.pointerDown(viewport, sample(2, 400));
  fireEvent.pointerCancel(object, sample(1));
  fireEvent.pointerDown(viewport, sample(3, 600));
  fireEvent.pointerMove(viewport, sample(3, 700));
  fireEvent.pointerUp(viewport, sample(2, 400));
  fireEvent.pointerUp(viewport, sample(3, 700));
  expect(navigate).not.toHaveBeenCalled();
  expect(zoom).not.toHaveBeenCalled();
  fireEvent.pointerDown(viewport, sample(4));
  fireEvent.pointerDown(viewport, sample(5, 400));
  expect(navigate).toHaveBeenCalledOnce();
  fireEvent.pointerCancel(viewport, sample(4));
  fireEvent.pointerCancel(viewport, sample(5));
});
