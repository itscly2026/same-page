import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { installReadingPreferenceLocks } from "../../test/reading-preference-locks";
import { activateAuthenticatedLocalOwner, captureLocalWorkspaceSession, createLocalWorkspace } from "../platform/local-workspace";
import { localDatabase } from "../platform/local-database";
import { clearReadResources } from "../settings/read-resource";
import { SettingsRequestError } from "../settings/settings-request";
import { restoreDriveReadingPreferences } from "./reading-preferences";
import { useDriveReadingPreferences } from "./use-reading-preferences";

const defaults = (colorOverride: string | null = null) => ({
  drive: { id: "drive", name: "排练云盘" },
  layers: [{ slot: "S", name: "Soprano", subscribed: false, colorOverride,
    adminDefaultColor: "#dc2626", displayColor: colorOverride ?? "#dc2626", colorSource: colorOverride ? "drive" : "admin" }],
});
const workspaceFor = async (user = "reader") => captureLocalWorkspaceSession(
  createLocalWorkspace(await activateAuthenticatedLocalOwner(user), "drive", ""));
beforeEach(async () => {
  installReadingPreferenceLocks();
  await localDatabase.open();
});

it("keeps choices made during a read after PUT succeeds and after offline reopening", async () => {
  const workspace = await workspaceFor();
  let release!: (response: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => init?.method === "PUT"
    ? new Response(null, { status: 200 }) : Response.json(defaults()));
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(() => useDriveReadingPreferences(workspace, true));
  await waitFor(() => expect(view.result.current.authority).toBe("confirmed"));
  fetch.mockImplementation(async (_input, init) => init?.method === "PUT"
    ? new Response(null, { status: 200 }) : new Promise(resolve => { release = resolve; }));
  let refreshing!: Promise<void>;
  act(() => { refreshing = view.result.current.refresh(); });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(() => view.result.current.save({ kind: "drive", id: "S" }, { subscribed: true, colorOverride: "#123456" }));
  await waitFor(() => expect(view.result.current.feedback({ kind: "drive", id: "S" })?.message).toBe("已同步。"));
  await act(async () => { release(Response.json(defaults())); await refreshing; });
  expect(view.result.current.layers[0]).toMatchObject({ subscribed: true, displayColor: "#123456" });
  view.unmount();
  clearReadResources();
  localDatabase.close(); await localDatabase.open();
  fetch.mockRejectedValue(new Error("offline"));
  const reopened = renderHook(() => useDriveReadingPreferences(workspace, false));
  await waitFor(() => expect(reopened.result.current.layers[0]).toMatchObject({ subscribed: true, displayColor: "#123456" }));
});

it("accepts fresh remote colors without resending an observed color on the next visibility change", async () => {
  const workspace = await workspaceFor();
  let serverDefaults = defaults();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => init?.method === "PUT"
    ? new Response(null, { status: 200 }) : Response.json(serverDefaults));
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(() => useDriveReadingPreferences(workspace, true));
  await waitFor(() => expect(view.result.current.authority).toBe("confirmed"));
  await act(() => view.result.current.save({ kind: "drive", id: "S" }, { colorOverride: "#ff0000" }));
  await waitFor(() => expect(view.result.current.feedback({ kind: "drive", id: "S" })?.message).toBe("已同步。"));
  serverDefaults = defaults("#0000ff");
  await act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.layers[0].displayColor).toBe("#0000ff"));
  await act(() => view.result.current.save({ kind: "drive", id: "S" }, { subscribed: true }));
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ subscribed: true }) })));
  expect(view.result.current.layers[0].displayColor).toBe("#0000ff");
});

it("does not recreate revoked layers from retained local choices", async () => {
  const workspace = await workspaceFor();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(defaults()));
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(() => useDriveReadingPreferences(workspace, false));
  await waitFor(() => expect(view.result.current.layers).toHaveLength(1));
  await act(() => view.result.current.save({ kind: "drive", id: "S" }, { subscribed: true }));
  fetch.mockResolvedValue(new Response(null, { status: 403 }));
  await act(async () => { await expect(view.result.current.refresh()).rejects.toBeInstanceOf(SettingsRequestError); });
  expect(view.result.current.authority).toBe("revoked");
  expect(view.result.current.layers).toEqual([]);
  expect((await localDatabase.readingPreferences.toArray())[0]).toMatchObject({ pending: true, subscribed: true });
});

it("rejects a late read after the local owner leaves and returns", async () => {
  const workspace = await workspaceFor();
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(() => new Promise(resolve => { release = resolve; })));
  const view = renderHook(() => useDriveReadingPreferences(workspace, false));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await workspaceFor("other");
  const returned = await workspaceFor();
  await act(async () => { release(Response.json(defaults())); });
  await waitFor(() => expect(view.result.current.error).toBeTruthy());
  expect(view.result.current.layers).toEqual([]);
  expect(await restoreDriveReadingPreferences(returned)).toBeNull();
});
