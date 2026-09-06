import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import type { PDFDocumentProxy } from "./pdf-document";
import {
  ContinuousLayout,
  PageLayout,
  type AnnotationPageProps,
} from "./reader-layouts";
import type { PagedReader } from "./use-paged-reader";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 808,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 808,
        end: index * 808 + 800,
        size: 800,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

const annotationProps: AnnotationPageProps = {
  workspace: createLocalWorkspace(
    authenticatedLocalOwnerKey("user-1"),
    "choir-1",
    "score-1",
  ),
  layers: [],
  annotations: [],
  editing: false,
  tool: "text",
  activeLayerId: null,
  onInteractionChange: vi.fn(),
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    {} as CanvasRenderingContext2D,
  );
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".page-reader__viewport, .continuous-reader") ? 600 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches(".page-reader__viewport, .continuous-reader") ? 800 : 0;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reader layout canvas alignment", () => {
  it.each(["page", "continuous"] as const)(
    "keeps the PDF and annotation overlay in one page frame after a %s layout zoom",
    async (layout) => {
      const document = createDocument();
      const pager = createPager();
      const view = render(renderLayout(layout, 1, document, pager));
      const overlay = await screen.findByLabelText("第 1 页批注层");
      const firstFrame = overlay.closest<HTMLElement>(".annotated-pdf-page");
      const firstCanvas = firstFrame?.querySelector<HTMLElement>(".pdf-page-canvas");
      expect(firstFrame).not.toBeNull();
      expect(firstFrame).toContainElement(firstCanvas ?? null);
      expect(firstCanvas?.style.width).toBe(firstFrame?.style.width);
      const firstWidth = Number.parseFloat(firstFrame?.style.width ?? "0");

      view.rerender(renderLayout(layout, 2, document, pager));
      await waitFor(() => {
        const frame = screen
          .getByLabelText("第 1 页批注层")
          .closest<HTMLElement>(".annotated-pdf-page");
        expect(Number.parseFloat(frame?.style.width ?? "0")).toBeCloseTo(
          firstWidth * 2,
        );
      });

      const settledOverlay = screen.getByLabelText("第 1 页批注层");
      const settledFrame = settledOverlay.closest<HTMLElement>(".annotated-pdf-page");
      const settledCanvas = settledFrame?.querySelector<HTMLElement>(".pdf-page-canvas");
      expect(settledFrame).toBe(firstFrame);
      expect(settledFrame).toContainElement(settledCanvas ?? null);
      expect(settledCanvas?.style.width).toBe(settledFrame?.style.width);
    },
  );
});

function createDocument() {
  return {
    numPages: 1,
    getPage: vi.fn().mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    }),
  } as unknown as PDFDocumentProxy;
}

function createPager(): PagedReader {
  return {
    anchorPage: 1,
    targetPage: null,
    phase: "idle",
    progress: 0,
    items: [{ page: 1, position: 0 }],
    request: vi.fn(),
    gesture: {
      begin: vi.fn(),
      move: vi.fn(() => false),
      end: vi.fn(() => false),
      cancel: vi.fn(() => true),
    },
    failedPage: null, retryPage: vi.fn(), renderKey: page => String(page),
    beginPageRender: vi.fn(() => ({ ready: vi.fn(), failed: vi.fn(), cancel: vi.fn() })),
    finishTransition: vi.fn(),
  };
}

function renderLayout(
  layout: "page" | "continuous",
  zoom: number,
  document: PDFDocumentProxy,
  pager: PagedReader,
) {
  const common = {
    document,
    currentPage: 1,
    zoom,
    onZoomChange: vi.fn(),
    onToggleChrome: vi.fn(),
    annotationProps,
  };
  return layout === "page" ? (
    <PageLayout {...common} pager={pager} />
  ) : (
    <ContinuousLayout
      {...common}
      onPageChange={vi.fn()}
    />
  );
}
