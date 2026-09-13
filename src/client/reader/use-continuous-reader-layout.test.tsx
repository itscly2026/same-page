import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "./pdf-document";
import { Context } from "../navigation/navigation-context";
import { useContinuousReaderLayout } from "./use-continuous-reader-layout";

let width = 600;
let height = 800;
const resize = new Set<() => void>();
beforeEach(() => {
  width = 600; height = 800;
  vi.stubGlobal("ResizeObserver", class {
    constructor(private notify: (entries: unknown[]) => void) {}
    callback = () => this.notify([]);
    observe() { resize.add(this.callback); this.callback(); }
    unobserve() {}
    disconnect() { resize.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) {
    return Number.parseFloat(this.firstElementChild?.getAttribute("style")?.match(/height: ([\d.]+)px/)?.[1] ?? "5000");
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() {},
  }));
  HTMLElement.prototype.scrollTo = function(options: ScrollToOptions | number = {}, y?: number) {
    this.scrollTop = typeof options === "number" ? y ?? 0 : options.top ?? this.scrollTop;
    this.scrollLeft = typeof options === "number" ? options : options.left ?? this.scrollLeft;
  };
});
afterEach(() => { resize.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function pdf(ratios: number[], delayed = false) {
  let release!: () => void;
  const ready = delayed ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  return {
    document: { numPages: ratios.length, getPage: async (page: number) => {
      await ready;
      return { getViewport: () => ({ width: ratios[page - 1] * 100, height: 100 }) };
    } } as PDFDocumentProxy,
    release: () => release(),
  };
}
function Harness({ document, initialPage = 1, editing = false, idle = () => true, deferZoom = false }: {
  document: PDFDocumentProxy; initialPage?: number; editing?: boolean; idle?: () => boolean; deferZoom?: boolean;
}) {
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const requestedZoom = useRef(1);
  const [fitRequest, fit] = useState(0);
  const { scrollRef, contentRef, onScroll, geometryGestures, width, height, items } = useContinuousReaderLayout({ document, currentPage: page, zoom, fitRequest,
    editing, canTurnEditingPage: idle, onPageChange: setPage, onZoomChange: value => { requestedZoom.current = value; if (!deferZoom) setZoom(value); } });
  return <>
    <output data-testid="page">{page}</output><output data-testid="zoom">{zoom}</output>
    <button onClick={() => setZoom(requestedZoom.current)}>commit zoom</button>
    <button onClick={() => setPage(1)}>select first</button>
    <button onClick={() => fit(value => value + 1)}>fit</button>
    <button onClick={() => geometryGestures.onEditingPageTurn?.("next")}>next</button>
    <button onClick={() => geometryGestures.onEditingPageTurn?.("previous")}>previous</button>
    <div data-testid="viewport" ref={scrollRef} onScroll={onScroll}>
      <div ref={contentRef} style={{ width: width, height: height }}>
        {items.map(item => <div key={item.index} data-testid={`page-${item.index + 1}`}
          style={{ height: item.width / item.aspectRatio, transform: `translateY(${item.start}px)` }} />)}
      </div>
    </div>
  </>;
}
function mount(props: Parameters<typeof Harness>[0]) {
  const result = render(<MemoryRouter><Harness {...props} /></MemoryRouter>);
  return { ...result, update: (next: Parameters<typeof Harness>[0]) => result.rerender(<MemoryRouter><Harness {...next} /></MemoryRouter>) };
}
it("waits for destination metadata before committing an editing turn fit", async () => {
  const source = pdf([1, 0.5, 2], true);
  mount({ document: source.document, editing: true });
  fireEvent.click(screen.getByText("next"));
  expect(screen.getByTestId("page")).toHaveTextContent("2");
  expect(screen.getByTestId("zoom")).toHaveTextContent("1");
  await act(async () => source.release());
  await waitFor(() => expect(Number(screen.getByTestId("zoom").textContent)).toBeCloseTo(2 / 3));
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBeCloseTo(612));
});

it("discards an old document's delayed metadata and pending turn", async () => {
  const old = pdf([1, 0.5, 2], true);
  const next = pdf([2, 2, 2], true);
  const view = mount({ document: old.document, editing: true });
  fireEvent.click(screen.getByText("next"));
  view.update({ document: next.document, editing: false });
  await act(async () => next.release());
  await waitFor(() => expect(screen.getByTestId("page-2")).toHaveStyle({ height: "300px" }));
  const position = screen.getByTestId("viewport").scrollTop;
  await act(async () => old.release());
  expect(screen.getByTestId("zoom")).toHaveTextContent("1");
  expect(screen.getByTestId("viewport").scrollTop).toBe(position);
  expect(screen.getByTestId("page-2")).toHaveStyle({ height: "300px" });
});

it("keeps a requested short page during program scroll, then uses the reading viewport center", async () => {
  mount({ document: pdf([2, 2, 2, 2, 2]).document, initialPage: 3 });
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(616));
  fireEvent.scroll(screen.getByTestId("viewport"));
  expect(screen.getByTestId("page")).toHaveTextContent("3");
  screen.getByTestId("viewport").scrollTop = 650;
  fireEvent.scroll(screen.getByTestId("viewport"));
  expect(screen.getByTestId("page")).toHaveTextContent("4");
});

it("recomputes a pending fit with the latest viewport and metadata", async () => {
  const source = pdf([1, 0.5, 2], true);
  mount({ document: source.document, initialPage: 2 });
  fireEvent.click(screen.getByText("fit"));
  act(() => { width = 1000; height = 600; resize.forEach(notify => notify()); });
  await act(async () => source.release());
  await waitFor(() => expect(Number(screen.getByTestId("zoom").textContent)).toBe(0.3));
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(308));
  act(() => { height = 800; resize.forEach(notify => notify()); });
  await waitFor(() => expect(Number(screen.getByTestId("zoom").textContent)).toBe(0.4));
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(408));
});

it("reads the idle gate on release, never replays rejected turns, and centers short boundary pages", async () => {
  let idle = false;
  mount({ document: pdf([2, 1, 2]).document, initialPage: 2, editing: true, idle: () => idle });
  await screen.findByTestId("page-2");
  fireEvent.click(screen.getByText("next"));
  expect(screen.getByTestId("page")).toHaveTextContent("2");
  idle = true;
  act(() => { resize.forEach(notify => notify()); });
  expect(screen.getByTestId("page")).toHaveTextContent("2");
  fireEvent.click(screen.getByText("next"));
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(920));
  fireEvent.click(screen.getByText("next"));
  expect(screen.getByTestId("page")).toHaveTextContent("3");
  fireEvent.click(screen.getByText("previous"));
  fireEvent.click(screen.getByText("previous"));
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(4));
  fireEvent.click(screen.getByText("previous"));
  expect(screen.getByTestId("page")).toHaveTextContent("1");
});

it("restores the visit's actual position after delayed geometry without initial alignment overwriting it", async () => {
  const source = pdf([1, 0.5, 1], true);
  const returnState = new Map<string, unknown>([["default:/:viewport:continuous", { top: 950, left: 35 }]]);
  render(<MemoryRouter><Context.Provider value={{ returnState,
    register: () => () => {}, back: () => {}, afterEditing: action => action() }}>
    <Harness document={source.document} initialPage={2} />
  </Context.Provider></MemoryRouter>);
  expect(screen.getByTestId("viewport").scrollTop).toBe(0);
  await act(async () => source.release());
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(950));
  fireEvent.scroll(screen.getByTestId("viewport"));
  expect(screen.getByTestId("page")).toHaveTextContent("2");
  expect(screen.getByTestId("viewport").scrollLeft).toBe(35);
  act(() => { resize.forEach(notify => notify()); });
  expect(screen.getByTestId("viewport").scrollTop).toBe(950);
});

it("waits for committed zoom and lets a newer page replace the pending fit", async () => {
  mount({ document: pdf([1, 0.5, 2]).document, initialPage: 2, deferZoom: true });
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(608));
  fireEvent.click(screen.getByText("fit"));
  expect(screen.getByTestId("zoom")).toHaveTextContent("1");
  expect(screen.getByTestId("viewport").scrollTop).toBe(608);
  screen.getByTestId("viewport").scrollTop = 1300;
  fireEvent.scroll(screen.getByTestId("viewport"));
  expect(screen.getByTestId("page")).toHaveTextContent("2");
  act(() => { height = 600; resize.forEach(notify => notify()); });
  fireEvent.click(screen.getByText("commit zoom"));
  await waitFor(() => expect(Number(screen.getByTestId("zoom").textContent)).toBe(0.5));
  expect(screen.getByTestId("viewport").scrollTop).toBe(308);
  fireEvent.click(screen.getByText("select first"));
  fireEvent.click(screen.getByText("commit zoom"));
  await waitFor(() => expect(screen.getByTestId("viewport").scrollTop).toBe(0));
  expect(screen.getByTestId("page")).toHaveTextContent("1");
});
