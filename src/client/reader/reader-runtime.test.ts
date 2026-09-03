import { afterEach, describe, expect, it, vi } from "vitest";

import { preloadPdfWorkerAsset } from "./pdf-document";
import { scheduleReaderRuntimePreload } from "./reader-runtime";

describe("reader runtime preparation", () => {
  afterEach(() => {
    document.head.querySelector("link[data-same-page-pdf-worker]")?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prepares the PDF worker asset without requesting a score PDF", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    preloadPdfWorkerAsset();
    preloadPdfWorkerAsset();

    const links = document.head.querySelectorAll<HTMLLinkElement>(
      "link[data-same-page-pdf-worker]",
    );
    expect(links).toHaveLength(1);
    expect(links[0].rel).toBe("modulepreload");
    expect(links[0].href).toMatch(/pdf\.worker.*\.mjs$/);
    expect(links[0].href).not.toContain("/api/choirs/");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses bounded idle preparation and can cancel it", async () => {
    vi.useFakeTimers();
    const prepare = vi.fn().mockResolvedValue(undefined);

    const cancel = scheduleReaderRuntimePreload(prepare);
    cancel();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).not.toHaveBeenCalled();

    scheduleReaderRuntimePreload(prepare);
    await vi.advanceTimersByTimeAsync(600);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
