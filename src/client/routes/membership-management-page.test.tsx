import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { effectiveCapabilities, emptyPermissions } from "../../shared/drive-permissions";
import MembershipManagementPage from "./membership-management-page";
vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }) } }));
afterEach(() => vi.unstubAllGlobals());
const member = { id: "member", displayName: "小花", isOwner: 0, operations: emptyPermissions(), management: emptyPermissions(), status: "active", removedAt: null, revision: 1, userDeleted: 0, recoverable: 1 };
const state = { capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()), actorId: "owner", memberships: [member] };
const overview = { isMember: true, name: "排练云盘", guestAdmissionMode: "open", capabilities: state.capabilities, layers: [] };
const page = () => <MemoryRouter initialEntries={["/choirs/drive/memberships"]}><Routes><Route path="/choirs/:choirId/memberships" element={<MembershipManagementPage />} /></Routes></MemoryRouter>;

it("keeps confirmed saves and the member list when refreshing fails, and only retries reading", async () => {
  let saved = false, unavailable = true, writes = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/management")) return Response.json(overview);
    if (init?.method === "PUT") { saved = true; writes++; return Response.json({ ok: true }); }
    if (url.endsWith("/permission-layers")) return Response.json({ layers: [] });
    if (url.endsWith("/permission-changes")) return Response.json({ changes: [] });
    return saved && unavailable ? new Response(null, { status: 503 }) : Response.json({ ...state, memberships: [{ ...member, revision: saved ? 2 : 1 }] });
  }));
  render(page());
  fireEvent.click(await screen.findByRole("heading", { name: "小花" }));
  fireEvent.click(screen.getByText("编辑权限"));
  fireEvent.click(screen.getByRole("checkbox", { name: "上传文件：可以操作" }));
  fireEvent.click(screen.getByRole("button", { name: "保存 小花 的权限" }));
  expect(await screen.findByText(/已保存。但刷新失败/)).toBeVisible();
  expect(screen.getByRole("heading", { name: "小花" })).toBeVisible();
  expect(screen.getByRole("button", { name: "保存 小花 的权限" })).toBeDisabled();
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "重新读取成员列表" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重新读取成员列表" })).not.toBeInTheDocument());
  expect(writes).toBe(1);
  expect(screen.queryByText(/但刷新失败/)).not.toBeInTheDocument();
});

it("distinguishes an unreadable permission log from no changes and allows a read retry", async () => {
  let unavailable = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/management") ? Response.json(overview) : url.endsWith("/permission-changes")
    ? unavailable ? new Response(null, { status: 503 }) : Response.json({ changes: [] })
    : url.endsWith("/permission-layers") ? Response.json({ layers: [] }) : Response.json(state)));
  render(page());
  fireEvent.click(await screen.findByText("最近权限变更记录"));
  expect(await screen.findByText(/权限记录读取失败/)).toBeVisible();
  expect(screen.queryByText("暂无权限变更记录。")).not.toBeInTheDocument();
  unavailable = false;
  fireEvent.click(screen.getByRole("button", { name: "重新读取记录" }));
  expect(await screen.findByText("暂无权限变更记录。")).toBeVisible();
});

it("recovers a revision conflict without discarding the failed permission edits", async () => {
  let conflict = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/management")) return Response.json(overview);
    if (init?.method === "PUT") { conflict = true; return Response.json({ error: "membership_conflict" }, { status: 409 }); }
    if (url.endsWith("/permission-layers")) return Response.json({ layers: [] });
    if (url.endsWith("/permission-changes")) return Response.json({ changes: [] });
    return Response.json({ ...state, memberships: [{ ...member, revision: conflict ? 2 : 1 }] });
  }));
  render(page());
  fireEvent.click(await screen.findByRole("heading", { name: "小花" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "上传文件：可以操作" }));
  fireEvent.click(screen.getByRole("button", { name: "保存 小花 的权限" }));
  fireEvent.click(await screen.findByRole("button", { name: "重新读取成员列表" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "重新读取成员列表" })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("heading", { name: "小花" }));
  expect(screen.getByRole("checkbox", { name: "上传文件：可以操作" })).toBeChecked();
});

it("clears a failed audit read when a permission save automatically refreshes the log", async () => {
  let saved = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/management")) return Response.json(overview);
    if (init?.method === "PUT") { saved = true; return Response.json({ ok: true }); }
    if (url.endsWith("/permission-layers")) return Response.json({ layers: [] });
    if (url.endsWith("/permission-changes")) return saved ? Response.json({ changes: [] }) : new Response(null, { status: 503 });
    return Response.json({ ...state, memberships: [{ ...member, revision: saved ? 2 : 1 }] });
  }));
  render(page());
  fireEvent.click(await screen.findByText("最近权限变更记录"));
  await screen.findByText(/权限记录读取失败/);
  fireEvent.click(screen.getByRole("heading", { name: "小花" }));
  fireEvent.click(screen.getByText("编辑权限"));
  fireEvent.click(screen.getByRole("checkbox", { name: "上传文件：可以操作" }));
  fireEvent.click(screen.getByRole("button", { name: "保存 小花 的权限" }));
  expect(await screen.findByText("暂无权限变更记录。")).toBeVisible();
  expect(screen.queryByText(/权限记录读取失败/)).not.toBeInTheDocument();
});

it("lets ordinary members inspect owner, delegated scopes and layer grants from either view", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/management") ? Response.json(overview) : url.endsWith("/permission-layers") ? Response.json({ layers: [{ slot: "S", name: "Soprano" }] }) : Response.json({ ...state, capabilities: effectiveCapabilities(false, emptyPermissions(), emptyPermissions()), memberships: [{ ...member, operations: { operations: ["uploadFiles"], sharedLayers: ["S"] }, management: { operations: ["modifyFiles"], sharedLayers: [] } }] })));
  render(page());
  fireEvent.click(await screen.findByRole("heading", { name: "小花" }));
  expect(screen.getByText(/操作权限：上传文件、Soprano/)).toBeVisible();
  expect(screen.getByText(/授权管理范围：修改文件/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存 小花 的权限" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "按权限" }));
  fireEvent.change(screen.getByLabelText("选择权限"), { target: { value: "layer:S" } });
  expect(within(screen.getByRole("region", { name: "可以操作" })).getByText("小花")).toBeVisible();
  expect(screen.queryByText(/操作权限：上传文件/)).not.toBeInTheDocument();
});

it("shares drafts and revision checks across member and permission views", async () => {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/management")) return Response.json(overview);
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); }
    return url.endsWith("/permission-layers") ? Response.json({ layers: [{ slot: "S", name: "Soprano" }] }) : url.endsWith("/permission-changes") ? Response.json({ changes: [] }) : Response.json(state);
  }));
  render(page());
  fireEvent.click(await screen.findByRole("heading", { name: "小花" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "上传文件：可以操作" }));
  fireEvent.click(screen.getByRole("radio", { name: "按权限" }));
  fireEvent.change(screen.getByLabelText("选择权限"), { target: { value: "layer:S" } });
  fireEvent.click(screen.getByText("调整此项权限"));
  fireEvent.change(screen.getByLabelText("选择成员"), { target: { value: "member" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "编辑 Soprano：可以操作" }));
  fireEvent.click(screen.getByRole("button", { name: "保存 小花 的权限" }));
  await waitFor(() => expect(writes).toEqual([{ expectedRevision: 1, operations: { operations: ["uploadFiles"], sharedLayers: ["S"] }, management: emptyPermissions() }]));
});

it("explains an out-of-scope permission to a delegated manager without offering an empty save", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/management") ? Response.json(overview) : url.endsWith("/permission-layers") ? Response.json({ layers: [] }) : Response.json({ ...state, capabilities: effectiveCapabilities(false, emptyPermissions(), { operations: ["uploadFiles"], sharedLayers: [] }) })));
  render(page());
  await screen.findByRole("heading", { name: "小花" });
  fireEvent.click(screen.getByRole("radio", { name: "按权限" }));
  fireEvent.change(screen.getByLabelText("选择权限"), { target: { value: "modifyFiles" } });
  expect(screen.getByText(/这项权限不在你的授权管理范围内/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存 小花 的权限" })).not.toBeInTheDocument();
});

it("shows nonmember feature guidance without requesting the member list", async () => {
  const fetch = vi.fn(async () => Response.json({ ...overview, isMember: false, capabilities: effectiveCapabilities(false, emptyPermissions(), emptyPermissions()) }));
  vi.stubGlobal("fetch", fetch);
  render(page());
  expect(await screen.findByText(/成员名单与个人权限仅向云盘成员开放/)).toBeVisible();
  expect(screen.queryByText("小花")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "重新读取成员列表" })).not.toBeInTheDocument();
  expect(fetch.mock.calls).toHaveLength(1);
});
