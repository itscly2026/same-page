import { afterEach, expect, it, vi } from "vitest";
import { foregroundDeadline, waitForForeground } from "./foreground-deadline";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("counts foreground time across repeated visibility events and disposes listeners", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const expire = vi.fn();
  const dispose = foregroundDeadline(expire, 20_000);
  await vi.advanceTimersByTimeAsync(5_000);
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(expire).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(14_999);
  expect(expire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(expire).toHaveBeenCalledTimes(1);
  dispose();
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(expire).toHaveBeenCalledTimes(1);
});

it("does not run a disposed hidden deadline on foreground", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const expire = vi.fn();
  foregroundDeadline(expire, 10)();
  visibility.mockReturnValue("visible");
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(100);
  expect(expire).not.toHaveBeenCalled();
});

it("aborts a queued hidden render without resuming it later", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const abort = new AbortController();
  const waiting = waitForForeground(abort.signal);
  abort.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
});
