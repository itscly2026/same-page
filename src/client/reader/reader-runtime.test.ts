import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleReaderRuntimePreload } from "./reader-runtime";

describe("reader runtime preparation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses bounded idle preparation and can cancel it", async () => {
    vi.useFakeTimers();
    const prepare = vi.fn().mockResolvedValue(undefined);

    const cancel = scheduleReaderRuntimePreload(prepare);
    cancel();
    await vi.runAllTimersAsync();
    expect(prepare).not.toHaveBeenCalled();

    scheduleReaderRuntimePreload(prepare);
    await vi.runAllTimersAsync();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
