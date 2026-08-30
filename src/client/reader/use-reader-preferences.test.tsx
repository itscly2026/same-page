import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReaderPreferences } from "./use-reader-preferences";

describe("useReaderPreferences", () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("restores one scoped layout and page preference without leaking to another score", async () => {
    const scope = { identity: "guest", choirId: "choir-1", scoreId: "score-1" };
    const first = renderHook(() => useReaderPreferences(scope));

    act(() => {
      first.result.current.setLayout("continuous");
      first.result.current.setCurrentPage(3);
    });
    await waitFor(() =>
      expect(
        stored.get("reader-preferences:guest:choir-1:score-1"),
      ).toBe('{"layout":"continuous","page":3}'),
    );
    first.unmount();

    const reopened = renderHook(() => useReaderPreferences(scope));
    expect(reopened.result.current.layout).toBe("continuous");
    expect(reopened.result.current.currentPage).toBe(3);

    const otherScore = renderHook(() =>
      useReaderPreferences({ ...scope, scoreId: "score-2" }),
    );
    expect(otherScore.result.current.layout).toBe("page");
    expect(otherScore.result.current.currentPage).toBe(1);
  });
});
