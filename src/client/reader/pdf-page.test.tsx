import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PDFDocumentProxy } from "./pdf-document";
import { PdfPageCanvas } from "./pdf-page";
import { DisplayRecovery } from "./display-recovery";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PdfPageCanvas", () => {
  it("keeps the visible bitmap intact until its replacement is committed", async () => {
    const pendingRenders: Array<() => void> = [];
    const renderPage = vi.fn(() => ({
      promise: new Promise<void>((resolve) => pendingRenders.push(resolve)),
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
    let clearedVisibleCanvas = false;
    const widthSetter = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      "width",
    )?.set;
    vi.spyOn(HTMLCanvasElement.prototype, "width", "set").mockImplementation(
      function (this: HTMLCanvasElement, value: number) {
        if (value === 1 && this.hasAttribute("data-pdf-canvas-active")) {
          clearedVisibleCanvas = true;
        }
        widthSetter?.call(this, value);
      },
    );

    const view = render(
      <PdfPageCanvas document={document} pageNumber={1} width={600} />,
    );
    await waitFor(() => expect(pendingRenders).toHaveLength(1));
    pendingRenders[0]();
    await waitFor(() =>
      expect(view.container.querySelector("[data-pdf-canvas-active]")).not.toBeNull(),
    );
    const firstCanvas = view.container.querySelector("[data-pdf-canvas-active]");

    view.rerender(
      <PdfPageCanvas document={document} pageNumber={1} width={1200} />,
    );
    await waitFor(() => expect(pendingRenders).toHaveLength(2));
    pendingRenders[1]();
    await waitFor(() =>
      expect(view.container.querySelector("[data-pdf-canvas-active]")).not.toBe(
        firstCanvas,
      ),
    );

    expect(clearedVisibleCanvas).toBe(false);
    expect(firstCanvas).toHaveAttribute("hidden");
    expect((firstCanvas as HTMLCanvasElement).width).toBe(1);
  });
});


it("confirms a prefetched bitmap when it becomes current without redrawing it", async () => {
  const acknowledged = vi.fn();
  const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const document = { getPage: vi.fn().mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: renderPage,
  }) } as unknown as PDFDocumentProxy;
  function Scene({ currentPage }: { currentPage: number }) {
    const recovery = { currentPage, ready: (page: number) => { if (page === currentPage) acknowledged(page); }, failed: vi.fn() };
    return <DisplayRecovery.Provider value={recovery}><PdfPageCanvas document={document} pageNumber={10} width={600} /></DisplayRecovery.Provider>;
  }
  const view = render(<Scene currentPage={11} />);
  await waitFor(() => expect(view.container.querySelector("[data-pdf-canvas-active]")).not.toBeNull());
  expect(acknowledged).not.toHaveBeenCalled();
  view.rerender(<Scene currentPage={10} />);
  await waitFor(() => expect(acknowledged).toHaveBeenCalledWith(10));
  expect(renderPage).toHaveBeenCalledTimes(1);
});

it("does not confirm a replacement document using the retained old bitmap", async () => {
  const finishes: Array<() => void> = [];
  const makeDocument = () => ({ getPage: vi.fn().mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: new Promise<void>(resolve => finishes.push(resolve)), cancel: vi.fn() }),
  }) }) as unknown as PDFDocumentProxy;
  const previous = makeDocument();
  const replacement = makeDocument();
  const acknowledged = vi.fn();
  function Scene({ document, currentPage }: { document: PDFDocumentProxy; currentPage: number }) {
    const recovery = { currentPage, ready: (page: number) => { if (page === currentPage) acknowledged(document, page); }, failed: vi.fn() };
    return <DisplayRecovery.Provider value={recovery}><PdfPageCanvas document={document} pageNumber={10} width={600} /></DisplayRecovery.Provider>;
  }
  const view = render(<Scene document={previous} currentPage={11} />);
  await waitFor(() => expect(finishes).toHaveLength(1));
  finishes[0]();
  await waitFor(() => expect(view.container.querySelector("[data-pdf-canvas-active]")).not.toBeNull());
  view.rerender(<Scene document={replacement} currentPage={10} />);
  await waitFor(() => expect(finishes).toHaveLength(2));
  expect(acknowledged).not.toHaveBeenCalled();
  finishes[1]();
  await waitFor(() => expect(acknowledged).toHaveBeenCalledWith(replacement, 10));
});
