import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppRoutes } from "../app";
import { authClient } from "../auth/auth-client";
import { clearDriveLibraryCache, driveCacheOwnerKey, rememberDriveSummary } from "../score-library/drive-library-cache";
import type { MembershipSummary } from "../../shared/choirs";

vi.mock("../auth/auth-client", () => ({ authClient: {
  useSession: vi.fn(), signOut: vi.fn(), signIn: { email: vi.fn(), social: vi.fn() },
} }));

const membership = (id: string): MembershipSummary => ({ id: `membership-${id}`, role: "member", displayName: "排练者",
  choir: { id, name: `云盘 ${id}`, guestAdmissionMode: "invite" } });
let memberships: MembershipSummary[];
function session(userId: string | null, isPending = false) {
  vi.mocked(authClient.useSession).mockReturnValue({ data: userId ? { user: { id: userId, email: "singer@example.test" } } : null, isPending } as ReturnType<typeof authClient.useSession>);
}
function NavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output aria-label="当前位置">{location.pathname}{location.search}</output><button onClick={() => void navigate(-1)}>返回测试</button></>;
}
function tree(entries = ["/"]) { return <MemoryRouter initialEntries={entries}><AppRoutes /><NavigationProbe /></MemoryRouter>; }
function expectPath(path: string) { expect(screen.getByLabelText("当前位置").textContent).toBe(path); }

beforeEach(() => {
  clearDriveLibraryCache();
  sessionStorage.clear();
  memberships = [membership("one")];
  session("user-a");
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/choirs") return Response.json({ memberships });
    if (input === "/api/auth/social-providers") return Response.json({ providers: [] });
    if (input === "/api/auth/flow") return Response.json({ flow: "sign-in" });
    if (input.endsWith("/bootstrap")) {
      const id = input.split("/")[3];
      return Response.json({ choir: membership(id).choir, scores: [], storage: { usedBytes: 0, limitBytes: 1073741824 }, permissions: { access: "membership", canManage: false } });
    }
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("replaces the default entry with the only membership, even with a remembered preview", async () => {
  rememberDriveSummary(driveCacheOwnerKey("user-a", "preview"), { id: "preview", name: "公开体验", guestAdmissionMode: "open" });
  render(tree(["/privacy", "/"]));
  await screen.findByRole("heading", { name: "云盘 one" });
  expectPath("/choirs/one");
  fireEvent.click(screen.getByRole("button", { name: "返回测试" }));
  await screen.findByRole("heading", { name: "隐私政策" });
  expectPath("/privacy");
});

it.each([0, 2])("keeps %i memberships at the selection entry without injecting preview", async (count) => {
  memberships = count ? [membership("one"), { ...membership("two"), role: "admin" }] : [];
  render(tree());
  if (count) {
    await screen.findByRole("link", { name: /云盘 one.*成员/ });
    expect(screen.getByRole("link", { name: /云盘 two.*管理员/ })).toHaveAttribute("href", "/choirs/two");
  } else await screen.findByText(/还没有已加入的云盘/);
  expectPath("/");
  expect(screen.getByRole("button", { name: "加入新云盘" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /公开体验/ })).not.toBeInTheDocument();
});

it("keeps explicit invitation intent and the switch picker accessible with one membership", async () => {
  render(tree(["/?join=1"]));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/choirs", expect.anything()));
  expect(screen.getByRole("dialog", { name: "加入新云盘" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expectPath("/?join=1");
  fireEvent.click(screen.getByRole("link", { name: /云盘 one.*成员/ }));
  await screen.findByRole("heading", { name: "云盘 one" });
  fireEvent.click(screen.getByRole("button", { name: "切换云盘" }));
  await screen.findByRole("link", { name: /云盘 one.*成员 · 当前云盘/ });
  expect(screen.getByRole("dialog", { name: "切换云盘" })).toBeInTheDocument();
  expectPath("/choirs/one");
});

it("does not override an explicit drive deep link with the sole membership", async () => {
  render(tree(["/choirs/explicit"]));
  await screen.findByRole("heading", { name: "云盘 explicit" });
  expectPath("/choirs/explicit");
  expect(fetch).not.toHaveBeenCalledWith("/api/choirs", expect.anything());
});

it("shows a retry instead of using cached metadata as membership authorization", async () => {
  rememberDriveSummary(driveCacheOwnerKey("user-a", "one"), membership("one").choir);
  const original = vi.mocked(fetch).getMockImplementation()!;
  let fail = true;
  vi.mocked(fetch).mockImplementation((input, init) => input === "/api/choirs" && fail ? Promise.resolve(new Response(null, { status: 503 })) : original(input, init));
  render(tree());
  await screen.findByText("暂时无法加载已加入的云盘。");
  expectPath("/");
  expect(screen.queryByRole("link", { name: /云盘 one/ })).not.toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("heading", { name: "云盘 one" });
});

it("hides unresolved identity and ignores a previous user's late membership response", async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation((input, init) => input === "/api/choirs" ? new Promise(resolve => { finish = resolve; }) : original(input, init));
  const view = render(tree());
  await screen.findByText("正在加载已加入的云盘…");
  session("user-a", true);
  view.rerender(tree());
  expect(screen.queryByText("我已加入的云盘")).not.toBeInTheDocument();
  session("user-b");
  memberships = [];
  vi.mocked(fetch).mockImplementation(original);
  view.rerender(tree());
  await screen.findByText(/还没有已加入的云盘/);
  await act(async () => finish(Response.json({ memberships: [membership("private-a")] })));
  expectPath("/");
  expect(screen.queryByText(/private-a/)).not.toBeInTheDocument();
});

it("clears a loaded previous user's list synchronously on identity change", async () => {
  memberships = [membership("private-a"), membership("two")];
  const view = render(tree());
  await screen.findByRole("link", { name: /云盘 private-a.*成员/ });
  session("user-b");
  memberships = [];
  view.rerender(tree());
  expect(screen.queryByText(/private-a/)).not.toBeInTheDocument();
  await screen.findByText(/还没有已加入的云盘/);
});

it("continues a completed email login through the default entry without retaining login in history", async () => {
  session(null);
  vi.mocked(authClient.signIn.email).mockImplementation(async () => {
    session("user-a");
    return { data: null, error: null };
  });
  render(tree(["/privacy", "/login"]));
  fireEvent.change(await screen.findByLabelText("邮箱"), { target: { value: "singer@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  fireEvent.change(await screen.findByLabelText("密码"), { target: { value: "test-password" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByRole("heading", { name: "云盘 one" });
  fireEvent.click(screen.getByRole("button", { name: "返回测试" }));
  await screen.findByRole("heading", { name: "隐私政策" });
  expectPath("/privacy");
});
