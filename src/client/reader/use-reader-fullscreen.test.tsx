import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useReaderFullscreen } from "./use-reader-fullscreen";

afterEach(() => vi.restoreAllMocks());
function platform(request: () => Promise<void>) {
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => true });
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
}
afterEach(() => {
  for (const name of ["fullscreenEnabled", "fullscreenElement", "exitFullscreen"]) Reflect.deleteProperty(document, name);
  Reflect.deleteProperty(document.documentElement, "requestFullscreen");
});
it("reports unsupported fullscreen without interrupting reading", async () => {
  const {result} = renderHook(() => useReaderFullscreen());
  await act(() => result.current.toggle());
  expect(result.current.message).toContain("不支持系统全屏");
  expect(result.current.active).toBe(false);
});
it("reports rejection and allows a new gesture to retry", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined);
  platform(request);
  const {result} = renderHook(() => useReaderFullscreen());
  await act(() => result.current.toggle());
  expect(result.current.message).toContain("未允许");
  await act(() => result.current.toggle());
  expect(request).toHaveBeenCalledTimes(2);
  expect(result.current.message).toBeNull();
});
it("exits a pending fullscreen request if the reader is left before it resolves", async () => {
  let complete!: () => void;
  platform(() => new Promise(resolve => { complete = resolve; }));
  const {result, unmount} = renderHook(() => useReaderFullscreen());
  act(() => { void result.current.toggle(); });
  unmount();
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => document.documentElement });
  complete();
  await waitFor(() => expect(document.exitFullscreen).toHaveBeenCalledOnce());
});
