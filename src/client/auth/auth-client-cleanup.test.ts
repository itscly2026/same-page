import { afterEach, expect, it, vi } from "vitest";
import { authClient } from "./auth-client";
import { cleanupAuthClient } from "../../test/cleanup-auth-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("finishes real session listener cleanup before the browser environment is destroyed", () => {
  vi.useFakeTimers();
  const added = vi.spyOn(window, "addEventListener");
  const unsubscribe = authClient.$store.atoms.session.listen(() => {});
  expect(added.mock.calls.some(([type]) => type === "storage")).toBe(true);
  unsubscribe();
  cleanupAuthClient();
  vi.stubGlobal("window", undefined);
  try {
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
  } finally {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    added.mockRestore();
  }
});
