import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  usePagedReader,
  type PageRenderLease,
  type PageTurnSample,
} from "./use-paged-reader";

let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", () => mediaQuery(false));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("usePagedReader", () => {
  it("returns to the current page when local navigation admission fails", async () => {
    const onPageChange = vi.fn();
    const beforePageChange = vi.fn(async () => false);
    const { result } = renderHook(() => usePagedReader({ currentPage: 2, pageCount: 4,
      documentKey: "admission", enabled: true, onPageChange, beforePageChange }));
    finishRenders(result.current.beginPageRender, 3);
    act(() => result.current.request("next"));
    await act(async () => { flushFrame(); });
    expect(beforePageChange).toHaveBeenCalledOnce();
    expect(result.current.anchorPage).toBe(2);
    expect(result.current.phase).toBe("idle");
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("keeps the current page when a prefetched target fails and retries its render", () => {
    const { result } = renderPager(vi.fn());
    let render!: PageRenderLease;
    act(() => { render = result.current.beginPageRender(3); render.failed(); });
    act(() => result.current.request(3));
    expect(result.current.anchorPage).toBe(2);
    expect(result.current.failedPage).toBe(3);
    const key = result.current.renderKey(3);
    act(() => result.current.retryPage());
    expect(result.current.failedPage).toBeNull();
    expect(result.current.renderKey(3)).not.toBe(key);
    act(() => { render = result.current.beginPageRender(3); render.ready(); });
    flushFrame();
    expect(result.current.phase).toBe("settling");
    act(() => result.current.finishTransition());
    expect(result.current.anchorPage).toBe(3);
  });

  it("accepts the first request in the same commit that enables paging", () => {
    const onPageChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => {
        const pager = usePagedReader({
          currentPage: 2,
          pageCount: 6,
          documentKey: "document-1",
          enabled,
          onPageChange,
        });
        const requestPage = pager.request;
        useLayoutEffect(() => {
          if (enabled) requestPage("next");
        }, [enabled, requestPage]);
        return pager;
      },
      { initialProps: { enabled: false } },
    );
    finishRenders(result.current.beginPageRender, 3);

    rerender({ enabled: true });

    expect(result.current.phase).toBe("preparing");
    flushFrame();
    expect(result.current.phase).toBe("settling");
  });

  it("lets pinch claim an idle pointer but rejects it during page settling", () => {
    const { result } = renderPager(vi.fn());
    let claimed = false;
    act(() => result.current.gesture.begin(sample(9, 500, 300, 0)));
    act(() => {
      claimed = result.current.gesture.cancel(9, true);
    });
    expect(claimed).toBe(true);

    finishRenders(result.current.beginPageRender, 3);
    act(() => result.current.request("next"));
    flushFrame();
    act(() => result.current.gesture.begin(sample(10, 500, 300, 10)));
    act(() => {
      claimed = result.current.gesture.cancel(10, true);
    });
    expect(result.current.phase).toBe("settling");
    expect(claimed).toBe(false);
  });

  it("keeps the minimal page window aligned while a drag commits", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 1, 2, 3);
    expect(result.current.items).toEqual([
      { page: 1, position: -1 },
      { page: 2, position: 0 },
      { page: 3, position: 1 },
    ]);

    act(() => result.current.gesture.begin(sample(1, 500, 300, 0)));
    act(() => result.current.gesture.move(sample(1, 180, 300, 100)));
    expect(result.current.phase).toBe("dragging");
    expect(result.current.progress).toBeCloseTo(-0.32);
    expect(result.current.targetPage).toBe(3);

    act(() => result.current.gesture.end(sample(1, 180, 300, 110)));
    flushFrame();
    expect(result.current.phase).toBe("settling");
    expect(result.current.progress).toBe(-1);
    act(() => result.current.finishTransition());
    expect(onPageChange).toHaveBeenCalledWith(3);
    expect(result.current.anchorPage).toBe(3);
  });

  it("rebounds an insufficient drag and pointer cancel without changing page", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 1, 2, 3);

    act(() => result.current.gesture.begin(sample(2, 500, 300, 0)));
    act(() => result.current.gesture.move(sample(2, 390, 300, 300)));
    act(() => result.current.gesture.end(sample(2, 390, 300, 310)));
    expect(result.current.phase).toBe("settling");
    expect(result.current.progress).toBe(0);
    act(() => result.current.finishTransition());
    expect(result.current.anchorPage).toBe(2);

    act(() => result.current.gesture.begin(sample(3, 500, 300, 300)));
    act(() => result.current.gesture.move(sample(3, 250, 300, 400)));
    act(() => result.current.gesture.cancel(3));
    act(() => result.current.finishTransition());
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it("commits a short fast swipe but follows a quick reversal back", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 1, 2, 3);

    act(() => result.current.gesture.begin(sample(4, 500, 300, 0)));
    act(() => result.current.gesture.move(sample(4, 430, 300, 20)));
    act(() => result.current.gesture.end(sample(4, 430, 300, 21)));
    flushFrame();
    expect(result.current.progress).toBe(-1);
    act(() => result.current.finishTransition());
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    act(() => result.current.gesture.begin(sample(5, 500, 300, 30)));
    act(() => result.current.gesture.move(sample(5, 180, 300, 80)));
    act(() => result.current.gesture.move(sample(5, 490, 300, 90)));
    act(() => result.current.gesture.end(sample(5, 490, 300, 91)));
    expect(result.current.progress).toBe(0);
  });

  it("queues rapid programmatic input and waits for an unrendered target", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 1, 2, 3, 4);

    act(() => result.current.request("next"));
    expect(result.current.phase).toBe("preparing");
    flushFrame();
    expect(result.current.phase).toBe("settling");
    act(() => result.current.request("next"));
    act(() => result.current.finishTransition());
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    expect(result.current.targetPage).toBe(4);
    flushFrame();
    act(() => result.current.finishTransition());
    expect(onPageChange).toHaveBeenLastCalledWith(4);

    act(() => result.current.request(6));
    expect(result.current.phase).toBe("preparing");
    expect(result.current.items).toContainEqual({ page: 6, position: 1 });
    expect(frames).toHaveLength(0);
    finishRenders(result.current.beginPageRender, 6);
    flushFrame();
    expect(result.current.phase).toBe("settling");
  });

  it("resists edge drags without exposing a page or changing the page number", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange, { currentPage: 1 });
    finishRenders(result.current.beginPageRender, 1, 2);
    act(() => result.current.gesture.begin(sample(6, 500, 300, 0)));
    act(() => result.current.gesture.move(sample(6, 850, 300, 100)));
    expect(result.current.targetPage).toBeNull();
    expect(result.current.progress).toBe(0.08);
    act(() => result.current.gesture.end(sample(6, 850, 300, 110)));
    act(() => result.current.finishTransition());
    expect(onPageChange).not.toHaveBeenCalled();
    expect(result.current.anchorPage).toBe(1);
  });

  it("switches only after the target is ready when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", () => mediaQuery(true));
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 2);
    act(() => result.current.request(5));
    expect(result.current.phase).toBe("preparing");
    expect(onPageChange).not.toHaveBeenCalled();
    finishRenders(result.current.beginPageRender, 5);
    flushFrame();
    expect(onPageChange).toHaveBeenCalledWith(5);
    expect(result.current.phase).toBe("idle");
  });

  it("invalidates readiness across page render lifecycles", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    let staleLease!: PageRenderLease;
    let currentLease!: PageRenderLease;
    act(() => {
      staleLease = result.current.beginPageRender(3);
      staleLease.ready();
      currentLease = result.current.beginPageRender(3);
    });

    act(() => result.current.request("next"));

    expect(result.current.phase).toBe("preparing");
    expect(frames).toHaveLength(0);
    act(() => staleLease.ready());
    expect(frames).toHaveLength(0);
    act(() => currentLease.ready());
    flushFrame();
    expect(result.current.phase).toBe("settling");
  });

  it("keeps an unrendered target covered during drag", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    act(() => result.current.gesture.begin(sample(7, 500, 300, 0)));

    act(() => result.current.gesture.move(sample(7, 180, 300, 100)));

    expect(result.current.phase).toBe("dragging");
    expect(result.current.targetPage).toBe(3);
    expect(result.current.progress).toBe(0);
    finishRenders(result.current.beginPageRender, 3);
    act(() => result.current.gesture.move(sample(7, 170, 300, 120)));
    expect(result.current.progress).toBeCloseTo(-0.33);
  });

  it("preserves a committed drag while its covered target finishes rendering", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    act(() => result.current.gesture.begin(sample(8, 500, 300, 0)));
    act(() => result.current.gesture.move(sample(8, 180, 300, 100)));
    expect(result.current.progress).toBe(0);

    act(() => result.current.gesture.end(sample(8, 180, 300, 110)));

    expect(result.current.phase).toBe("preparing");
    expect(result.current.targetPage).toBe(3);
    expect(onPageChange).not.toHaveBeenCalled();
    finishRenders(result.current.beginPageRender, 3);
    flushFrame();
    expect(result.current.phase).toBe("settling");
    expect(result.current.progress).toBe(-1);
  });

  it("continues rapid queued input after a reduced-motion switch", () => {
    vi.stubGlobal("matchMedia", () => mediaQuery(true));
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 3, 4);

    act(() => result.current.request("next"));
    act(() => result.current.request("next"));
    flushFrame();
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    expect(result.current.targetPage).toBe(4);
    flushFrame();
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    expect(result.current.phase).toBe("idle");
  });

  it("serializes new input while continuing a queued transition", () => {
    const onPageChange = vi.fn();
    const { result } = renderPager(onPageChange);
    finishRenders(result.current.beginPageRender, 3, 4, 5);
    act(() => result.current.request("next"));
    flushFrame();
    act(() => result.current.request("next"));

    act(() => result.current.finishTransition());

    expect(result.current.phase).toBe("preparing");
    expect(result.current.targetPage).toBe(4);
    act(() => result.current.request("next"));
    flushFrame();
    act(() => result.current.finishTransition());
    expect(result.current.targetPage).toBe(5);
  });
});

function renderPager(
  onPageChange: (page: number) => void,
  overrides: Partial<Parameters<typeof usePagedReader>[0]> = {},
) {
  return renderHook(() => usePagedReader({
    currentPage: 2,
    pageCount: 6,
    documentKey: "document-1",
    enabled: true,
    onPageChange,
    ...overrides,
  }));
}

function sample(
  sessionId: number,
  x: number,
  y: number,
  time: number,
): PageTurnSample {
  return { sessionId, x, y, time, extent: 1000 };
}

function finishRenders(
  begin: (page: number) => PageRenderLease,
  ...pages: number[]
) {
  act(() => pages.forEach((page) => begin(page).ready()));
}

function flushFrame() {
  const callback = frames.shift();
  expect(callback).toBeDefined();
  act(() => callback?.(performance.now()));
}

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}
