import { afterEach, describe, expect, it, vi } from "vitest";

import { notifyReaderIdentityChange } from "./reader-cache-events";
import { classifyReaderOpen } from "./reader-reopen-tracker";

describe("reader reopen tracking", () => {
  afterEach(() => vi.useRealTimers());

  it("classifies only the same owner and score as a reopen", () => {
    notifyReaderIdentityChange();
    expect(classifyReaderOpen("one", "drive", "score")).toBe("cold");
    expect(classifyReaderOpen("one", "drive", "score")).toBe("reopen");
    expect(classifyReaderOpen("one", "drive", "other-score")).toBe("warm");
    expect(classifyReaderOpen("two", "drive", "score")).toBe("cold");
    notifyReaderIdentityChange();
    expect(classifyReaderOpen("one", "drive", "score")).toBe("cold");
  });

  it("classifies the same score as warm after the short document cache expires", () => {
    vi.useFakeTimers();
    notifyReaderIdentityChange();
    expect(classifyReaderOpen("one", "drive", "score")).toBe("cold");

    vi.advanceTimersByTime(15_001);

    expect(classifyReaderOpen("one", "drive", "score")).toBe("warm");
  });
});
