import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DriveSettingsDialog } from "./drive-settings-dialog";

afterEach(() => vi.unstubAllGlobals());
it("retains the draft after a revision conflict and requires a deliberate resave against refreshed settings", async () => {
  let revision = 0;
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    if (init?.method === "PATCH") {
      writes.push(JSON.parse(init.body));
      return writes.length === 1 ? new Response(null, { status: 409 }) : Response.json({ revision: 2 });
    }
    return Response.json({ name: "云盘", nameRevision: 0, displayName: revision++ ? "其他设备的新名" : "旧名", membershipRevision: revision - 1, canManage: false });
  }));
  const onSaved = vi.fn(async () => {});
  const onClose = vi.fn();
  render(<DriveSettingsDialog choirId="drive" field="display-name" onSaved={onSaved} onClose={onClose} />);
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
