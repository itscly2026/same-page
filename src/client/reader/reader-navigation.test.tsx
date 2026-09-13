import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePagedReader } from "./use-paged-reader";
import { useReaderGestures } from "./use-reader-gestures";

let frames = new Map<number, FrameRequestCallback>();
let frame = 0;
beforeEach(() => {
  frames = new Map(); frame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frame, callback); return frame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => vi.unstubAllGlobals());
function flush() { act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); }); }
function Harness({ editing, initialZoom }: { editing: boolean; initialZoom: number }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [page, changePage] = useState(2);
  const [zoom, changeZoom] = useState(initialZoom);
  const pager = usePagedReader({ currentPage: page, pageCount: 3, documentKey: "test", enabled: true,
    onPageChange: page => { changePage(page); changeZoom(1); } });
  useLayoutEffect(() => {
    const leases = [1, 2, 3].map(pager.beginPageRender);
    leases.forEach(lease => lease.ready());
    return () => leases.forEach(lease => lease.cancel());
  }, [pager.beginPageRender]);
  const handlers = useReaderGestures({ containerRef: viewport, contentRef: content, zoom,
    disabled: false, twoFingerOnly: editing, onZoomChange: changeZoom, onTap() {}, pageTurn: pager.gesture, pageTurnExtent: 1000 });
  return <div ref={viewport} data-testid="viewport" data-page={page} data-zoom={zoom} data-progress={pager.progress} {...handlers}>
    <div ref={content} data-testid="paper" />
  </div>;
}
function send(type: string, x: number, time: number, editing: boolean) {
  for (const id of editing ? [1, 2] : [1]) {
    const event = new PointerEvent(type, { bubbles: true, pointerType: "touch", pointerId: id, clientX: x + id * 100, clientY: 200 });
    Object.defineProperty(event, "timeStamp", { value: time });
    fireEvent(screen.getByTestId("viewport"), event);
  }
  flush();
}
for (const editing of [false, true]) {
  for (const zoom of [1, 2]) {
    it(`${editing ? "editing" : "reading"} at zoom ${zoom} consumes pan, reverses and shares page completion`, () => {
      render(<Harness editing={editing} initialZoom={zoom} />);
      const viewport = screen.getByTestId("viewport");
      const paper = screen.getByTestId("paper");
      viewport.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
      paper.getBoundingClientRect = () => new DOMRect(-viewport.scrollLeft, 0, 1000 * zoom, 800 * zoom);
      const allowance = (zoom - 1) * 1000;
      send("pointerdown", 500, 0, editing);
      if (allowance) {
        send("pointermove", 500 - allowance, 1000, editing);
        expect(viewport.scrollLeft).toBe(allowance);
        expect(viewport).toHaveAttribute("data-progress", "0");
      }
      send("pointermove", 400 - allowance, 1400, editing);
      expect(Number(viewport.dataset.progress)).toBeCloseTo(-0.1);
      send("pointermove", 500, 1800, editing);
      expect(viewport.scrollLeft).toBe(0);
      expect(viewport).toHaveAttribute("data-progress", "0");
      send("pointerup", 500, 1900, editing);
      expect(viewport).toHaveAttribute("data-page", "2");
      expect(viewport).toHaveAttribute("data-zoom", String(zoom));
      send("pointerdown", 500, 2000, editing);
      send("pointermove", 200 - allowance, 3000, editing);
      send("pointerup", 200 - allowance, 3010, editing);
      flush();
      expect(viewport).toHaveAttribute("data-page", "3");
      expect(viewport).toHaveAttribute("data-zoom", "1");
    });
  }
}

it("drains replaced pinch contacts without leaving an uncommitted transform", () => {
  render(<Harness editing={false} initialZoom={1} />);
  const viewport = screen.getByTestId("viewport");
  const paper = screen.getByTestId("paper");
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
  paper.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
  const point = (pointerId: number, clientX: number) => ({ pointerId, clientX, clientY: 200, pointerType: "touch" });
  fireEvent.pointerDown(viewport, point(1, 200));
  fireEvent.pointerDown(viewport, point(2, 400));
  fireEvent.pointerMove(viewport, point(2, 600));
  flush();
  expect(paper).toHaveAttribute("data-gesture-preview");
  fireEvent.pointerUp(viewport, point(2, 600));
  fireEvent.pointerDown(viewport, point(3, 450));
  fireEvent.pointerUp(viewport, point(1, 200));
  fireEvent.pointerUp(viewport, point(3, 450));
  expect(paper).not.toHaveAttribute("data-gesture-preview");
  expect(paper.style.getPropertyValue("--reader-gesture-scale")).toBe("");
  expect(viewport).toHaveAttribute("data-zoom", "1");
  expect(viewport).toHaveAttribute("data-page", "2");
});

it("does not apply consumed pan twice when two-finger translation becomes pinch", () => {
  render(<Harness editing={false} initialZoom={2} />);
  const viewport = screen.getByTestId("viewport");
  const paper = screen.getByTestId("paper");
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
  paper.getBoundingClientRect = () => new DOMRect(-viewport.scrollLeft, 0, 2000, 1600);
  const point = (pointerId: number, clientX: number) => ({ pointerId, clientX, clientY: 200, pointerType: "touch" });
  fireEvent.pointerDown(viewport, point(1, 400));
  fireEvent.pointerDown(viewport, point(2, 600));
  fireEvent.pointerMove(viewport, point(1, 300));
  fireEvent.pointerMove(viewport, point(2, 500));
  flush();
  expect(viewport.scrollLeft).toBe(100);
  fireEvent.pointerMove(viewport, point(2, 600));
  flush();
  // The original content anchor 500 maps to center 450 with scale 1.5,
  // including the already consumed scroll of 100.
  expect(paper.style.getPropertyValue("--reader-gesture-x")).toBe("-200px");
  expect(paper.style.getPropertyValue("--reader-gesture-scale")).toBe("1.5");
  fireEvent.pointerCancel(viewport, point(1, 300));
  fireEvent.pointerUp(viewport, point(2, 600));
  expect(viewport).toHaveAttribute("data-zoom", "2");
  expect(viewport).toHaveAttribute("data-page", "2");
});
