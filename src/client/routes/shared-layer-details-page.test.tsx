import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation/navigation";
import SharedLayerDetailsPage from "./shared-layer-details-page";
vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }) } }));
afterEach(() => vi.unstubAllGlobals());
const layer = { slot: "E", name: "Ensemble", defaultColor: "#dc2626", grantedMemberCount: 0, sortOrder: 0, active: true, revision: 0, deletedAt: null, recoverUntil: null };
const management = (name: string) => ({ drive: { id: "drive", name: "云盘" }, sharedLayerRevision: 0, activeSharedSlots: ["E"], layers: [{ ...layer, name }] });
const page = () => <MemoryRouter initialEntries={["/choirs/drive/shared-layers/E"]}><Routes><Route path="/choirs/:choirId/shared-layers/:slot" element={<SharedLayerDetailsPage />} /></Routes></MemoryRouter>;

it("keeps the confirmed configuration after a failed refresh and recovers by reading only", async () => {
  let name = "Ensemble", failRead = false, writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      writes++; name = JSON.parse(String(init.body)).name; failRead = true;
      return new Response(null, { status: 204 });
    }
    return failRead ? new Response(null, { status: 503 }) : Response.json(management(name));
  }));
  render(page());
  await waitFor(() => expect(screen.getByLabelText("名称")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "合唱" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText(/已保存。但刷新失败/);
  expect(screen.getByLabelText("名称")).toHaveValue("合唱");
  expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  failRead = false;
  fireEvent.click(screen.getByRole("button", { name: "重新读取共享层" }));
  await waitFor(() => expect(screen.queryByText(/已保存。但刷新失败/)).not.toBeInTheDocument());
  expect(screen.getByLabelText("名称")).toBeEnabled();
  expect(writes).toBe(1);
});

it("keeps rejected edits through a conflict read and uses fresh data for a pristine warm form", async () => {
  let name = "Ensemble", conflict = false;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { conflict = true; name = "云端名称"; return new Response(null, { status: 409 }); }
    return Response.json(management(name));
  }));
  const first = render(page());
  await waitFor(() => expect(screen.getByLabelText("名称")).toBeEnabled());
  first.unmount();
  name = "最新名称";
  render(page());
  await waitFor(() => expect(screen.getByLabelText("名称")).toHaveValue("最新名称"));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "我的修改" } });
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByRole("button", { name: "重新读取共享层" });
  expect(conflict).toBe(true);
  expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新读取共享层" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "保存设置" })).toBeEnabled());
  expect(screen.getByLabelText("名称")).toHaveValue("我的修改");
  fireEvent.click(screen.getByRole("button", { name: "取消修改" }));
  expect(screen.getByLabelText("名称")).toHaveValue("云端名称");
});

it("preserves save confirmation inside the exit dialog when the following read fails", async () => {
  let saved = false, writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") { saved = true; writes++; return new Response(null, { status: 204 }); }
    return saved ? new Response(null, { status: 503 }) : Response.json(management("Ensemble"));
  }));
  const router = createMemoryRouter([{ element: <NavigationProvider><Outlet /></NavigationProvider>, children: [
    { path: "/choirs/drive/shared-layers", element: <h1>共享层列表</h1> },
    { path: "/choirs/:choirId/shared-layers/:slot", element: <SharedLayerDetailsPage /> },
  ] }], { initialEntries: ["/choirs/drive/shared-layers", "/choirs/drive/shared-layers/E"] });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(screen.getByLabelText("名称")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "合唱" } });
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(await screen.findByRole("button", { name: "保存并返回" }));
  expect(await screen.findByRole("heading", { name: "修改已保存" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("已保存。但刷新失败"));
  expect(screen.getByRole("dialog")).not.toHaveTextContent("保存尚未确认");
  expect(screen.getByRole("button", { name: "保存并返回" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(screen.getByLabelText("名称")).toHaveValue("合唱");
  expect(screen.getByRole("button", { name: "重新读取共享层" })).toBeVisible();
  expect(writes).toBe(1);
});
