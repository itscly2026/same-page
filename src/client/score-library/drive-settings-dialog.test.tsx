import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DriveSettingsDialog } from "./drive-settings-dialog";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("retains the draft after a revision conflict and requires a deliberate resave against refreshed settings", async () => {
  let revision = 0;
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(init.body));
      return writes.length === 1 ? new Response(null, { status: 409 }) : Response.json({ revision: 2 });
    }
    return Response.json({ name: "云盘", nameRevision: 0, displayName: revision++ ? "其他设备的新名" : "旧名", membershipRevision: revision - 1, canEditDriveInfo: false });
  }));
  const onSaved = vi.fn(async () => {});
  const onClose = vi.fn();
  render(<DriveSettingsDialog choirId="drive" userId="reader" field="display-name" onSaved={onSaved} onClose={onClose} />);
  const input = await screen.findByDisplayValue("旧名");
  fireEvent.change(input, { target: { value: "我的新名" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText(/其他设备的新名/);
  expect(input).toHaveValue("我的新名");
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(writes).toEqual([{ displayName: "我的新名", expectedRevision: 0 }, { displayName: "我的新名", expectedRevision: 1 }]);
});

it("reopens with the known name and revision while a delayed refresh preserves the draft", async () => {
  let release!: (response: Response) => void;
  let reads = 0;
  const known = { name: "云盘", nameRevision: 0, displayName: "旧名", membershipRevision: 4, canEditDriveInfo: false };
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "PATCH") return Response.json({ revision: 5 });
    reads++;
    return reads === 1 ? Response.json(known) : new Promise<Response>(resolve => { release = resolve; });
  });
  vi.stubGlobal("fetch", fetchMock);
  const props = { choirId: "drive", userId: "reader", field: "display-name" as const, onSaved: async () => {}, onClose: () => {} };
  const first = render(<DriveSettingsDialog {...props} />);
  await screen.findByDisplayValue("旧名"); first.unmount();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
  render(<DriveSettingsDialog {...props} />);
  const input = screen.getByDisplayValue("旧名");
  expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: "正在编辑" } });
  await waitFor(() => expect(reads).toBe(2));
  release(Response.json({ ...known, displayName: "远端改名", membershipRevision: 5 }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存" })).toBeEnabled());
  expect(input).toHaveValue("正在编辑");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("display-name"), expect.objectContaining({ body: JSON.stringify({ displayName: "正在编辑", expectedRevision: 4 }) })));
});

it("retries only refreshing after a confirmed name save", async () => {
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => Response.json(init?.method === "PATCH" ? { revision: 1 } : { name: "云盘", nameRevision: 0, displayName: "旧名", membershipRevision: 0, canEditDriveInfo: false }));
  vi.stubGlobal("fetch", fetchMock);
  const onSaved = vi.fn().mockRejectedValueOnce(new Error("refresh unavailable")).mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<DriveSettingsDialog choirId="drive" userId="reader" field="display-name" onSaved={onSaved} onClose={onClose} />);
  fireEvent.change(await screen.findByDisplayValue("旧名"), { target: { value: "新名" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("修改已保存，内容刷新失败。请重试刷新。");
  fireEvent.click(screen.getByRole("button", { name: "重试刷新" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});
