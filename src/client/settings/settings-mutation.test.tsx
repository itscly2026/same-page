import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { useSettingsMutation } from "./settings-mutation";
import { SettingsRequestError } from "./settings-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("serializes writes and recovery reads before React renders pending", async () => {
  const response = deferred<Response>();
  const read = deferred<void>();
  const refresh = vi.fn(() => read.promise);
  const confirmed = vi.fn();
  const request = vi.fn(() => response.promise);
  const { result } = renderHook(() => useSettingsMutation({ refresh }), { wrapper: StrictMode });
  let first!: Promise<boolean | null>;
  await act(async () => {
    first = result.current.submit(request, { confirmed });
    expect(await result.current.submit(request)).toBeNull();
    await result.current.refresh();
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
  expect(result.current.pending).toBe(true);
  await act(async () => { response.resolve(new Response(null, { status: 204 })); });
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(result.current.pending).toBe(true);
  await act(async () => {
    expect(await result.current.submit(request)).toBeNull();
    read.resolve();
    expect(await first).toBe(true);
  });
  expect(result.current).toMatchObject({ pending: false, blocked: false, message: null });
});

it("ignores a write from a departed identity without invoking its domain completion", async () => {
  const response = deferred<Response>();
  const confirmed = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const previous = renderHook(() => useSettingsMutation({ refresh }));
  let submission!: Promise<boolean | null>;
  act(() => { submission = previous.result.current.submit(() => response.promise, { confirmed }); });
  previous.unmount();
  const next = renderHook(() => useSettingsMutation({ refresh }));
  await act(async () => {
    response.resolve(new Response(null, { status: 204 }));
    expect(await submission).toBeNull();
  });
  expect(confirmed).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(next.result.current).toMatchObject({ pending: false, message: null });
});

it("lets asynchronous domain completion stop after unmount and skips its refresh", async () => {
  const waiting = deferred<void>();
  const publish = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  const { result, unmount } = renderHook(() => useSettingsMutation({ refresh }));
  let submission!: Promise<boolean | null>;
  await act(async () => {
    submission = result.current.submit(async () => new Response(null, { status: 204 }), {
      confirmed: async (_response, isCurrent) => { await waiting.promise; if (isCurrent()) publish(); },
    });
  });
  unmount();
  await act(async () => { waiting.resolve(); expect(await submission).toBeNull(); });
  expect(publish).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it.each([
  { name: "transport uncertainty", status: null, message: "操作结果未确认", revoked: false },
  { name: "signed-out", status: 401, message: "登录已失效", revoked: true },
  { name: "revocation", status: 403, message: "你没有操作此设置的权限", revoked: true },
  { name: "revision conflict", status: 409, message: "保存失败", revoked: false },
])("requires a successful read after $name without resending the write", async ({ status, message, revoked }) => {
  const request = vi.fn(async () => {
    if (status === null) throw new TypeError("network unavailable");
    return new Response(null, { status });
  });
  const refresh = vi.fn().mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValue(undefined);
  const onRevoked = vi.fn();
  const confirmed = vi.fn();
  const { result } = renderHook(() => useSettingsMutation({ refresh, onRevoked }));
  await act(async () => { expect(await result.current.submit(request, { confirmed })).toBe(false); });
  expect(result.current.message).toContain(message);
  expect(result.current.needsRefresh).toBe(true);
  expect(onRevoked).toHaveBeenCalledTimes(revoked ? 1 : 0);
  expect(confirmed).not.toHaveBeenCalled();
  await act(async () => {
    expect(await result.current.submit(request)).toBeNull();
    await expect(result.current.refresh()).rejects.toThrow("read unavailable");
  });
  expect(result.current.message).toContain(message);
  expect(result.current.blocked).toBe(true);
  await act(async () => { await result.current.refresh(); });
  expect(result.current).toMatchObject({ needsRefresh: false, blocked: false, message: null });
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["projection", "refresh"])("keeps a confirmed write after %s failure and only retries reading", async failure => {
  const request = vi.fn(async () => new Response(null, { status: 204 }));
  const confirmed = vi.fn(async () => { if (failure === "projection") throw new Error("projection unavailable"); });
  const refresh = vi.fn().mockResolvedValue(undefined);
  if (failure === "refresh") refresh.mockRejectedValueOnce(new Error("read unavailable"));
  const { result } = renderHook(() => useSettingsMutation({ refresh }));
  await act(async () => { expect(await result.current.submit(request, { confirmed })).toBe(false); });
  expect(result.current.message).toContain("已保存。但刷新失败");
  expect(result.current.blocked).toBe(true);
  await act(async () => { await result.current.refresh(); });
  expect(result.current.blocked).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
  expect(confirmed).toHaveBeenCalledTimes(1);
});

it("clears authority when the post-save read reports revocation while preserving confirmation", async () => {
  const refresh = vi.fn().mockRejectedValue(new SettingsRequestError(403));
  const onRevoked = vi.fn();
  const { result } = renderHook(() => useSettingsMutation({ refresh, onRevoked }));
  await act(async () => { await result.current.submit(async () => new Response(null, { status: 204 })); });
  expect(onRevoked).toHaveBeenCalledTimes(1);
  expect(result.current.message).toContain("已保存。但刷新失败");
  expect(result.current.blocked).toBe(true);
});

it("allows a rejected validation to be corrected, and keeps completion-only success explicit", async () => {
  const refresh = vi.fn();
  const { result, rerender } = renderHook(({ enabled }) => useSettingsMutation({ enabled, refresh }), { initialProps: { enabled: false } });
  const request = vi.fn(async () => new Response(null, { status: 400 }));
  await act(async () => { expect(await result.current.submit(request)).toBeNull(); });
  expect(request).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await act(async () => { expect(await result.current.submit(request)).toBe(false); });
  expect(result.current.blocked).toBe(false);
  await act(async () => {
    expect(await result.current.submit(async () => new Response(null, { status: 204 }), { refresh: false, successMessage: "操作已确认。" })).toBe(true);
  });
  expect(result.current.message).toBe("操作已确认。");
  expect(refresh).not.toHaveBeenCalled();
});
