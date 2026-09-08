import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import LeaveDrivePage from "./leave-drive-page";
vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "member" } } }) } }));
afterEach(() => vi.unstubAllGlobals());
function setup(isOwner = 0) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method ? new Response(null, { status: 204 }) : Response.json({ userId: "member", reauthenticated: false, methods: [], deletion: null, memberships: [{ id: "membership", choirId: "drive", name: "排练云盘", displayName: "小林", isOwner, status: "active", revision: 3, removedAt: null }] }));
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter initialEntries={["/choirs/drive/me"]}><Routes><Route path="/choirs/:choirId/me" element={<LeaveDrivePage />} /><Route path="/drives" element={<h1>我的云盘</h1>} /></Routes></MemoryRouter>);
  return fetch;
}
it("requires named membership confirmation and preserves the lifecycle revision", async () => {
  const fetch = setup();
  fireEvent.click(await screen.findByRole("button", { name: "退出云盘成员身份" }));
  expect(screen.getByRole("dialog", { name: "退出「排练云盘」的成员身份" })).toBeVisible();
  expect(screen.getByText(/云端个人层保留三十天/)).toBeVisible();
  expect(fetch.mock.calls.some(([, init]) => init?.method)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "确认退出成员身份" }));
  expect(await screen.findByRole("heading", { name: "我的云盘" })).toBeVisible();
  expect(fetch).toHaveBeenCalledWith("/api/choirs/drive/memberships/membership", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "remove", expectedRevision: 3 }) }));
});
it("requires the owner to transfer ownership before leaving", async () => {
  setup(1);
  expect(await screen.findByRole("button", { name: "退出云盘成员身份" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "管理成员与交接" })).toBeVisible();
});
