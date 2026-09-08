import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { noCapabilities, emptyPermissions } from "../../shared/drive-permissions";
import DriveManagementPage from "./drive-management-page";
vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "member" } } }) } }));
afterEach(() => vi.unstubAllGlobals());
const page = () => <MemoryRouter initialEntries={["/choirs/drive/management"]}><Routes><Route path="/choirs/:choirId/management" element={<DriveManagementPage />} /></Routes></MemoryRouter>;
it("shows safe configuration and explains locked actions before opening an edit form or requesting credentials", async () => {
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("/management") ? { name: "排练云盘", guestAdmissionMode: "invite", capabilities: noCapabilities(), layers: [{ slot: "S", name: "Soprano", active: 1 }] } : { actorId: "member", capabilities: noCapabilities(), memberships: [{ id: "owner", displayName: "小林", isOwner: 1, status: "active", revision: 0, operations: emptyPermissions(), management: emptyPermissions() }] }));
  vi.stubGlobal("fetch", fetch);
  render(page());
  expect(await screen.findByText("Soprano · 启用")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /查看与轮换邀请码/ }));
  expect(screen.getByText("可以联系：小林。")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /修改云盘名称/ }));
  expect(screen.getByRole("heading", { name: "需要“修改基本信息”权限" })).toBeVisible();
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(["/api/choirs/drive/management", "/api/choirs/drive/memberships"]);
});
it("shows no management configuration when the server denies membership", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
  render(page());
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByRole("link", { name: "成员与权限" })).not.toBeInTheDocument();
});
