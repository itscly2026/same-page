import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReadResource, getReadResource } from "./read-resource";
import { useReadResource } from "./use-read-resource";
import { NAVIGATION_FRESH_MS, observeNavigationSession, observeNavigationResponse } from "./navigation-events";
import { SettingsRequestError } from "./settings-request";

afterEach(() => vi.restoreAllMocks());
function deferred<T>() { let resolve!: (data: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it("reuses only successful confirmations; expiry, manual refresh and failure never renew stale data", async () => {
  let now = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const resource = new ReadResource<string>();
  const load = vi.fn(async () => "confirmed");
  await resource.read(load, NAVIGATION_FRESH_MS);
  for (let i = 0; i < 10; i++) { now += 1000; await resource.read(load, NAVIGATION_FRESH_MS); }
  expect(load).toHaveBeenCalledTimes(1);
  resource.update("confirmed");
  now = 70_001;
  expect(resource.fresh(NAVIGATION_FRESH_MS)).toBe(false);
  const pending = deferred<string>();
  const refresh = vi.fn(() => pending.promise);
  const one = resource.read(refresh, NAVIGATION_FRESH_MS);
  expect(resource.read(refresh)).toBe(one);
  expect(resource.getSnapshot()).toMatchObject({ data: "confirmed", authority: "confirmed", request: "pending" });
  pending.resolve("updated"); await one;
  await resource.read(async () => { throw new Error("offline"); }).catch(() => {});
  expect(resource.fresh(NAVIGATION_FRESH_MS)).toBe(false);
  expect(resource.getSnapshot()).toMatchObject({ data: "updated", authority: "confirmed" });
  await resource.read(async () => { throw new SettingsRequestError(403); }).catch(() => {});
  expect(resource.getSnapshot()).toMatchObject({ data: null, authority: "revoked" });
});
it("shares reads across consumers, including when the initiating consumer leaves", async () => {
  const result = deferred<string>();
  let signal!: AbortSignal;
  const load = vi.fn((s: AbortSignal) => { signal = s; return result.promise; });
  const first = renderHook(() => useReadResource("user:drive:management", load, undefined, NAVIGATION_FRESH_MS));
  const second = renderHook(() => useReadResource("user:drive:management", load, undefined, NAVIGATION_FRESH_MS));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  first.unmount(); expect(signal.aborted).toBe(false);
  await act(async () => { result.resolve("name"); });
  expect(second.result.current.data).toBe("name");
  act(() => window.dispatchEvent(new Event("focus")));
  expect(load).toHaveBeenCalledTimes(1);
});
it("fences an old response on same-user session replacement and on a confirmed drive mutation", async () => {
  observeNavigationSession("user:session-one");
  const resource = getReadResource<string>("user:drive:management");
  const old = deferred<string>();
  const read = resource.read(() => old.promise);
  await Promise.resolve();
  observeNavigationSession("user:session-two");
  old.resolve("old identity"); await read;
  expect(resource.getSnapshot().data).toBeNull();
  const current = getReadResource<string>("user:drive:management");
  current.confirm("name");
  const beforeWrite = deferred<string>();
  const pending = current.read(() => beforeWrite.promise);
  await Promise.resolve();
  observeNavigationResponse("/api/choirs/drive/name", { method: "PATCH" }, Response.json({ revision: 1 }));
  current.confirm("new name"); beforeWrite.resolve("old name"); await pending;
  expect(current.getSnapshot().data).toBe("new name");
});

it("invalidates only mutation dependencies and fences capabilities after a denied write", async () => {
  const settings = getReadResource<string>("member:drive:settings");
  const usage = getReadResource<string>("member:drive:usage");
  const other = getReadResource<string>("member:other-drive:management");
  settings.confirm("display name"); usage.confirm("old usage"); other.confirm("other drive");
  observeNavigationResponse("/api/choirs/drive/scores/score/restore", { method: "POST" }, Response.json({}));
  expect(settings.fresh(NAVIGATION_FRESH_MS)).toBe(true);
  expect(usage.fresh(NAVIGATION_FRESH_MS)).toBe(false);
  expect(other.fresh(NAVIGATION_FRESH_MS)).toBe(true);
  observeNavigationResponse("/api/choirs/drive/name", { method: "PATCH" }, new Response(null, { status: 403 }));
  expect(settings.getSnapshot().authority).toBe("unconfirmed");
  expect(other.getSnapshot().authority).toBe("confirmed");
});
