import { StrictMode } from "react";
import { rememberLibraryView } from "./score-library/library-view-state";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./app";
import { authClient } from "./auth/auth-client";
import { localDatabase } from "./platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
  localWorkspaceRecordKey,
} from "./platform/local-workspace";
import {
  clearReaderScoreCache,
  peekReaderScore,
} from "./reader/reader-score-cache";
import {
  clearDriveLibraryCache,
  driveCacheOwnerKey,
  rememberDriveLibrary,
  rememberDriveSummary,
} from "./score-library/drive-library-cache";

const localWorkspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);

vi.mock("./auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
    signOut: vi.fn(),
  },
}));

describe("AppRoutes", () => {
  beforeEach(async () => {
    clearReaderScoreCache();
    clearDriveLibraryCache();
    window.sessionStorage.clear();
    await localDatabase.open();
    vi.mocked(authClient.useSession).mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({}, { status: 404 })
            : Response.json(
            input === "/api/choirs"
              ? { memberships: [] }
              : input.includes("/bootstrap")
              ? driveBootstrapBody()
              : input.includes("/scores")
              ? {
                  scores: [],
                  storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
                  permissions: { canManage: false },
                }
              : {
                  choir: {
                    id: "choir-1",
                    name: "小红花云盘",
                    guestAdmissionMode: "invite",
                  },
                  entryKind: "admission",
                },
            ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with the cloud-drive entry and keeps invitation admission focused", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Harmony begins on the Same Page" }),
    ).toHaveAttribute("lang", "en");
    expect(screen.getByText("你的笔记我的谱")).toHaveAttribute("lang", "zh-CN");
    expect(
      screen.getByText(
        "A cloud-based score library built for choir rehearsals and shared annotations.",
      ),
    ).toHaveAttribute("lang", "en");
    expect(
      screen.getByText("为合唱排练与共享批注打造的乐谱云盘。"),
    ).toHaveAttribute("lang", "zh-CN");
    expect(screen.getByRole("link", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));

    expect(screen.getByRole("dialog", { name: "进入云盘" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "我已加入的云盘" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录后查看" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(
      screen.getByRole("heading", { name: "使用邀请码进入新的云盘" }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText("邀请码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入" })).toBeDisabled();
    expect(screen.queryByText("无需注册，也可以访客身份只读访问。")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("edits drive-scoped defaults from My Preferences", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "singer@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/choirs/choir-1/shared-layer-preferences" && !init?.method) {
        return Promise.resolve(Response.json({
          drive: { id: "choir-1", name: "小红花云盘" },
          layers: [
            {
              slot: "E",
              name: "Ensemble",
              subscribed: true,
              colorOverride: null,
              adminDefaultColor: "#a12652",
              displayColor: "#a12652",
              colorSource: "admin",
            },
          ],
        }));
      }
      if (input === "/api/choirs/choir-1/shared-layers/E/preference") {
        return Promise.resolve(Response.json({ preference: { subscribed: false, colorOverride: null } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/preferences"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "阅读偏好" })).toBeInTheDocument();
    expect(await screen.findByText("小红花云盘")).toBeInTheDocument();
    const subscribed = await screen.findByRole("checkbox", { name: "E · 全体 默认显示" });
    expect(subscribed).toBeChecked();
    fireEvent.click(subscribed);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/choirs/choir-1/shared-layers/E/preference",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ subscribed: false }) }),
      );
    });
  });

  it("rolls back only the failed layer preference when saves overlap", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "singer@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let releaseEnsemble!: (response: Response) => void;
    let releaseSoprano!: (response: Response) => void;
    const ensembleSave = new Promise<Response>((resolve) => {
      releaseEnsemble = resolve;
    });
    const sopranoSave = new Promise<Response>((resolve) => {
      releaseSoprano = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (!init?.method) {
        return Promise.resolve(Response.json({
          drive: { id: "choir-1", name: "小红花云盘" },
          layers: ["E", "S"].map((slot) => ({
            slot,
            name: slot === "E" ? "Ensemble" : "Soprano",
            subscribed: true,
            colorOverride: null,
            adminDefaultColor: slot === "E" ? "#a12652" : "#7c3aed",
            displayColor: slot === "E" ? "#a12652" : "#7c3aed",
            colorSource: "admin",
          })),
        }));
      }
      if (input.endsWith("/E/preference")) return ensembleSave;
      if (input.endsWith("/S/preference")) return sopranoSave;
      return Promise.resolve(new Response(null, { status: 404 }));
    }));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/preferences"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: "E · 全体 默认显示" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "S · 女高音 默认显示" }));
    releaseEnsemble(new Response(null, { status: 500 }));
    releaseSoprano(Response.json({ preference: { subscribed: false } }));

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "E · 全体 默认显示" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "S · 女高音 默认显示" })).not.toBeChecked();
      expect(screen.getByRole("alert")).toHaveTextContent("保存失败，原设置已保留。");
      expect(screen.getByRole("button", { name: "重试 E · 全体" })).toBeInTheDocument();
    });
  });

  it("separates colors from display, retains confirmed colors on failure and retries the exact change", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "singer@example.test" } }, isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let fail = true;
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.resolve(fail
        ? new Response(null, { status: 503 }) : Response.json({ preference: {} }));
      return Promise.resolve(Response.json({
        drive: { id: "choir-1", name: "小红花云盘" },
        layers: [{ slot: "E", name: "Ensemble", subscribed: false, colorOverride: null,
          adminDefaultColor: "#a12652", displayColor: "#a12652", colorSource: "admin" }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/choirs/choir-1/preferences"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole("checkbox", { name: "E · 全体 默认显示" })).not.toBeChecked();
    expect(screen.queryByLabelText("E · 全体 批注颜色")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "批注颜色" }));
    expect(screen.getByRole("heading", { name: "批注颜色" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const color = screen.getByLabelText("E · 全体 批注颜色");
    expect(screen.queryByRole("button", { name: /恢复默认颜色/ })).not.toBeInTheDocument();
    fireEvent.change(color, { target: { value: "#123456" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，原设置已保留。");
    expect(color).toHaveValue("#a12652");
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试 E · 全体" }));
    await waitFor(() => expect(color).toHaveValue("#123456"));
    expect(screen.getByText("自定义")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/choirs/choir-1/shared-layers/E/preference",
      expect.objectContaining({ body: JSON.stringify({ colorOverride: "#123456" }) }));
    fireEvent.click(screen.getByRole("button", { name: "E · 全体 恢复默认颜色" }));
    await waitFor(() => expect(color).toHaveValue("#a12652"));
    expect(screen.getByText("云盘默认")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /恢复默认颜色/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "返回阅读偏好" }));
    expect(screen.getByRole("checkbox", { name: "E · 全体 默认显示" })).not.toBeChecked();
  });

  it("lists fixed shared layers in drive management", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      drive: { id: "choir-1", name: "小红花云盘" },
      layers: [
        {
          slot: "E",
          name: "Ensemble",
          defaultColor: "#a12652",
          grantedMemberCount: 2, sortOrder: 0, active: true,
        },
      ],
    })));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/shared-layers"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "共享层管理" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /E · 全体.*已授权 2 位成员/ })).toHaveAttribute(
      "href",
      "/choirs/choir-1/shared-layers/E",
    );
  });

  it("edits member grants from one shared-layer detail page", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/choirs/choir-1/shared-layers" && !init?.method) {
        return Promise.resolve(Response.json({
          drive: { id: "choir-1", name: "小红花云盘" },
          layers: [{ slot: "E", name: "Ensemble", defaultColor: "#a12652", grantedMemberCount: 0, sortOrder: 0, active: true }],
        }));
      }
      if (input === "/api/choirs/choir-1/shared-layers/E/grants" && !init?.method) {
        return Promise.resolve(Response.json({ members: [
          { id: "admin-membership", displayName: "管理员", role: "admin", granted: true },
          { id: "member-membership", displayName: "小林", role: "member", granted: false },
        ] }));
      }
      if (input === "/api/choirs/choir-1/shared-layers/E/grants/member-membership") {
        return Promise.resolve(Response.json({ grant: { membershipId: "member-membership", granted: true } }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/shared-layers/E"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "E · 全体" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "管理员 管理员" })).toBeDisabled();
    const member = screen.getByRole("checkbox", { name: "小林" });
    expect(member).not.toBeChecked();
    fireEvent.click(member);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/choirs/choir-1/shared-layers/E/grants/member-membership",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ granted: true }) }),
      );
    });
  });

  it("shows the public preview as the third independent signed-out entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({
                choir: {
                  id: "preview-choir",
                  name: "公开体验云盘",
                  guestAdmissionMode: "open",
                },
              })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "先看示例" }),
    ).toHaveAttribute("href", "/choirs/preview-choir");

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    expect(screen.queryByText("公开体验云盘")).not.toBeInTheDocument();
  });

  it("never renders an internal social-provider email in signed-in headers", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: {
        user: {
          id: "wechat-user",
          email: "wechat-unionid@wechat.placeholder.invalid",
        },
      },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const home = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(
      screen.queryByText("wechat-unionid@wechat.placeholder.invalid"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
    home.unmount();

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(
      screen.queryByText("wechat-unionid@wechat.placeholder.invalid"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "登录或注册" })).not.toBeInTheDocument();
  });

  it("keeps public preview out of signed-in membership lists", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({
                choir: {
                  id: "preview-choir",
                  name: "公开体验云盘",
                  guestAdmissionMode: "open",
                },
              })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/还没有已加入的云盘/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "先看示例" })).not.toBeInTheDocument();
    expect(screen.queryByText(/或先访问公开体验/)).not.toBeInTheDocument();
  });

  it("automatically admits a linked guest once under StrictMode", async () => {
    render(<StrictMode><MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}><AppRoutes /></MemoryRouter></StrictMode>);
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    const admissions = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(admissions[0][1]?.body).toBe(JSON.stringify({ admission: "invite", joinCode: "ABCDEFGH" }));
  });

  it("keeps a malformed invitation available for manual correction", async () => {
    render(<MemoryRouter initialEntries={["/?join=1#invite=bad"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByText("邀请链接无效，请输入当前邀请码。")).toBeInTheDocument();
    expect(await screen.findByLabelText("邀请码")).toHaveValue("");
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "POST")).toHaveLength(0);
  });

  it("normalizes a grouped pasted invitation and enters as a guest", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "abcd-efgh" },
    });
    expect(await screen.findByLabelText("邀请码")).toHaveValue("ABCD-EFGH");
    expect(document.querySelectorAll(".join-code-slot")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(
      await screen.findByRole("heading", { name: "小红花云盘" }),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "invite", joinCode: "ABCDEFGH" }),
    });
  });

  it("keeps invalid invitations in the entry dialog with clear feedback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) =>
        Promise.resolve(
          input === "/api/guest/session" && init?.method === "POST"
            ? Response.json({}, { status: 403 })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "AAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("邀请码无效或已失效。");
    expect(screen.getByRole("dialog", { name: "进入云盘" })).toBeInTheDocument();
  });

  it("explains when invitation attempts are rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) =>
        Promise.resolve(
          input === "/api/guest/session" && init?.method === "POST"
            ? Response.json({}, { status: 429 })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尝试次数过多，请稍后再试。",
    );
  });

  it("shows every existing membership to a signed-in user", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          memberships: [
            {
              id: "membership-1",
              displayName: "小花",
              role: "member",
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
            },
            {
              id: "membership-2",
              displayName: "Alto",
              role: "member",
              choir: {
                id: "choir-2",
                name: "周末云盘",
                guestAdmissionMode: "invite",
              },
            },
          ],
        }),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: /小红花云盘.*成员/ })).toHaveAttribute(
      "href",
      "/choirs/choir-1",
    );
    expect(screen.getByRole("link", { name: /周末云盘.*成员/ })).toHaveAttribute(
      "href",
      "/choirs/choir-2",
    );
    expect(screen.getByRole("heading", { name: "我已加入的云盘" })).toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("shows a signed-in empty membership section without adding fields to invitation entry", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ memberships: [] })),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    expect(await screen.findByText(/还没有已加入的云盘。/)).toBeInTheDocument();
    expect(await screen.findByLabelText("邀请码")).toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("asks a signed-in new member for a display name only after invitation validation", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const targetDrive = {
      id: "choir-2",
      name: "周末云盘",
      guestAdmissionMode: "invite",
    };
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ choir: targetDrive, entryKind: "admission" }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({ status: "display-name-required", choir: targetDrive }),
          );
        }
        if (input === "/api/choirs/join-current-guest" && init?.method === "POST") {
          return Promise.resolve(Response.json({ membership: { choir: targetDrive } }));
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(
      await screen.findByRole("dialog", { name: "加入「周末云盘」" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("显示名"), {
      target: { value: "小花" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入并进入" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/choirs/join-current-guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "小花" }),
      });
    });
  });

  it("waits for guest-session cleanup before accepting another invitation", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const targetDrive = {
      id: "choir-2",
      name: "周末云盘",
      guestAdmissionMode: "invite",
    };
    let finishDelete!: (response: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => {
      finishDelete = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) => {
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ choir: targetDrive, entryKind: "admission" }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({ status: "display-name-required", choir: targetDrive }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "DELETE") {
          return pendingDelete;
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));
    expect(
      await screen.findByRole("dialog", { name: "加入「周末云盘」" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    expect(screen.getByRole("button", { name: "正在验证…" })).toBeDisabled();

    finishDelete(new Response(null, { status: 204 }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "进入" })).toBeEnabled();
    });
  });

  it("enters directly when a signed-in user already belongs to the invited drive", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const targetDrive = {
      id: "choir-1",
      name: "小红花云盘",
      guestAdmissionMode: "invite",
    };
    const membership = {
      id: "membership-1",
      displayName: "小花",
      role: "member",
      choir: targetDrive,
    };
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/guest/session" && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ choir: targetDrive, entryKind: "admission" }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({ status: "joined", choir: targetDrive }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [membership] }));
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(Response.json(driveBootstrapBody({ access: "membership" })));
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    await screen.findByRole("searchbox", { name: "搜索乐谱" });
    expect(screen.getByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", {
      method: "DELETE",
    });
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("enters an open-admission choir only through its dedicated link", async () => {
    let admitted = false;
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/guest/choirs/spring-choir") {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开体验云盘",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          admitted = true;
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开体验云盘",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(
            admitted
              ? Response.json(driveBootstrapBody({
                  choir: {
                    id: "spring-choir",
                    name: "公开体验云盘",
                    guestAdmissionMode: "open",
                  },
                }))
              : Response.json({}, { status: 403 }),
          );
        }
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId: "spring-choir" }),
    }));
  });

  it("asks a signed-in user for a display name before joining an open choir", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let joined = false;
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/guest/choirs/spring-choir") {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开体验云盘",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/choirs/join" && init?.method === "POST") {
          joined = true;
          return Promise.resolve(
            Response.json(
              {
                membership: {
                  id: "membership-1",
                  displayName: "小花",
                  role: "member",
                  choir: {
                    id: "spring-choir",
                    name: "公开体验云盘",
                    guestAdmissionMode: "open",
                  },
                },
              },
              { status: 201 },
            ),
          );
        }
        if (input === "/api/choirs") {
          return Promise.resolve(
            Response.json({
              memberships: joined
                ? [
                    {
                      id: "membership-1",
                      displayName: "小花",
                      role: "member",
                      choir: {
                        id: "spring-choir",
                        name: "公开体验云盘",
                        guestAdmissionMode: "open",
                      },
                    },
                  ]
                : [],
            }),
          );
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(
            joined
              ? Response.json(driveBootstrapBody({
                  choir: {
                    id: "spring-choir",
                    name: "公开体验云盘",
                    guestAdmissionMode: "open",
                  },
                  access: "membership",
                }))
              : Response.json({}, { status: 403 }),
          );
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.change(
      await screen.findByLabelText("显示名"),
      { target: { value: "小花" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "加入并进入" }));

    expect(await screen.findByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/choirs/join", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        admission: "open",
        choirId: "spring-choir",
        displayName: "小花",
      }),
    }));
  });

  it("opens signed-in preview access without guest admission or joining", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "/api/choirs/preview-choir/bootstrap") {
        return Promise.resolve(Response.json(driveBootstrapBody({
          choir: { id: "preview-choir", name: "公开体验云盘", guestAdmissionMode: "open" },
          access: "preview",
        })));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/choirs/preview-choir"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "公开体验云盘" })).toBeInTheDocument();
    expect(screen.getByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开云盘菜单" }));
    expect(screen.queryByRole("menu", { name: "管理员菜单" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/choirs/join", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/guest/session", expect.objectContaining({ method: "POST" }));
  });

  it("lets an administrator read the current code and reopen it after rotation", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let currentCode = "HGFEDCBA";
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input.endsWith("/join-code")) {
          return Promise.resolve(Response.json({ joinCode: currentCode }));
        }
        if (input.endsWith("/join-code/rotate") && init?.method === "POST") {
          currentCode = "ABCDEFGH";
          return Promise.resolve(
            Response.json({ joinCode: currentCode }),
          );
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(
            Response.json(driveBootstrapBody({ canManage: true, access: "membership" })),
          );
        }
        return Promise.resolve(
          Response.json({
            choir: {
              id: "choir-1",
              name: "小红花云盘",
              guestAdmissionMode: "invite",
            },
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "打开云盘菜单" }));
    expect(await screen.findByRole("menuitem", { name: "共享层" })).toHaveAttribute(
      "href",
      "/choirs/choir-1/shared-layers",
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "邀请码" }));
    expect(await screen.findByRole("dialog", { name: "邀请加入云盘" })).toBeInTheDocument();
    expect(await screen.findByLabelText("当前有效邀请码")).toHaveTextContent("HGFEDCBA");
    fireEvent.click(screen.getByRole("button", { name: "轮换邀请码" }));

    expect(
      await screen.findByText("邀请码已轮换，可随时在这里查看。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("当前有效邀请码")).toHaveTextContent(
      "ABCDEFGH",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/choirs/choir-1/join-code/rotate",
      { method: "POST" },
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByLabelText("当前有效邀请码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开云盘菜单" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "邀请码" }));
    expect(await screen.findByLabelText("当前有效邀请码")).toHaveTextContent("ABCDEFGH");
  });

  it("links signed-in members to drive-scoped My Preferences", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string) =>
      Promise.resolve(input.includes("/bootstrap")
        ? Response.json(driveBootstrapBody({ access: "membership" }))
        : Response.json({
            choir: { id: "choir-1", name: "小红花云盘", guestAdmissionMode: "invite" },
          }))));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    await screen.findByRole("searchbox", { name: "搜索乐谱" });
    fireEvent.click(await screen.findByRole("button", { name: "用户菜单" }));
    expect(await screen.findByRole("menuitem", { name: "阅读偏好" })).toHaveAttribute(
      "href",
      "/choirs/choir-1/preferences",
    );
  });

  it("keeps management tools but hides invite-code controls for open guest admission", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes("/bootstrap")) {
        return Promise.resolve(
          Response.json(driveBootstrapBody({
            choir: {
              id: "spring-choir",
              name: "公开体验云盘",
              guestAdmissionMode: "open",
            },
            usedBytes: 900_000_000,
            canManage: true,
            access: "membership",
          })),
        );
      }
      return Promise.resolve(
        Response.json({
          choir: {
            id: "spring-choir",
            name: "公开体验云盘",
            guestAdmissionMode: "open",
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "上传 PDF" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/云盘存储已使用 858\.3 MB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开云盘菜单" }));
    expect(await screen.findByText(/云盘存储：858\.3 MB/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "回收站" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "轮换邀请码" }),
    ).not.toBeInTheDocument();
  });

  it("shows members a filename-first list without administrator storage controls", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) =>
      Promise.resolve(
        input.includes("/bootstrap")
          ? Response.json({
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
              scores: [
                {
                  id: "score-10",
                  choirId: "choir-1",
                  fileName: "排练 10.pdf",
                  updatedAt: 1,
                  currentVersion: {
                    id: "version-1",
                    versionNumber: 1,
                    sizeBytes: 2 * 1024 * 1024,
                    sha256: "a".repeat(64),
                    etag: '"etag"',
                    pageCount: 2,
                    createdAt: 1,
                  },
                },
              ],
              storage: { usedBytes: 950_000_000, limitBytes: 1_073_741_824 },
              permissions: { canManage: false, access: "guest" },
            })
          : Response.json({
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    const scoreLink = await screen.findByRole("link", { name: /排练 10\.pdf/ });
    expect(scoreLink).toHaveAttribute(
      "href",
      "/choirs/choir-1/scores/score-10",
    );
    fireEvent.click(scoreLink, { button: 1 });
    expect(peekReaderScore("guest", "choir-1", "score-10")).toMatchObject({
      id: "score-10",
      fileName: "排练 10.pdf",
      currentVersion: { id: "version-1" },
    });
    expect(screen.queryByRole("button", { name: "上传 PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回收站" })).not.toBeInTheDocument();
    expect(screen.queryByText(/云盘存储已使用/)).not.toBeInTheDocument();
    expect(screen.queryByText("2.0 MB")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /更多操作/ }));
    expect(screen.queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "文件信息" }));
    const info = await screen.findByRole("dialog", { name: "文件信息" });
    expect(within(info).getByText("2.0 MB")).toBeInTheDocument();
    fireEvent.click(within(info).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索乐谱" }), {
      target: { value: "排练" },
    });
    expect(screen.getByText("找到 1 份，共 1 份乐谱")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("?q="))).toBe(false);

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ error: "temporary" }, { status: 503 })),
    );
    fireEvent.submit(screen.getByRole("search"));
    expect(
      await screen.findByText("暂时无法更新乐谱列表，当前内容已保留。请稍后重试。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /排练 10\.pdf/ })).toBeInTheDocument();

  });

  it("restores a cached drive library while background refresh is delayed", async () => {
    const ownerKey = driveCacheOwnerKey(null, "choir-1");
    rememberDriveLibrary(ownerKey, "choir-1", {
      choir: {
        id: "choir-1",
        name: "小红花云盘",
        guestAdmissionMode: "invite",
      },
      result: {
        scores: [
          {
            id: "cached-score",
            choirId: "choir-1",
            fileName: "缓存中的春日.pdf",
            updatedAt: 1,
            currentVersion: {
              id: "cached-version",
              versionNumber: 1,
              sizeBytes: 2048,
              sha256: "a".repeat(64),
              etag: '"cached"',
              pageCount: 2,
              createdAt: 1,
            },
          },
        ],
        storage: { usedBytes: 2048, limitBytes: 1_073_741_824 },
        permissions: { canManage: false },
      },
    });
    rememberLibraryView(ownerKey, "choir-1", { search: "春日", sort: "name", scrollTop: 320 });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const root = document.documentElement;
    const originalScrollTop = Object.getOwnPropertyDescriptor(root, "scrollTop");
    let scrollTop = 0;
    let restoredAfterListCommit = false;
    Object.defineProperty(root, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        if (value === 320) {
          restoredAfterListCommit = document.querySelector(".file-list") !== null;
        }
      },
    });

    try {
      render(
        <MemoryRouter initialEntries={["/choirs/choir-1"]}>
          <AppRoutes />
        </MemoryRouter>,
      );

      expect(
        await screen.findByRole("link", { name: /缓存中的春日\.pdf/ }),
      ).toBeInTheDocument();
      expect(screen.getByRole("searchbox", { name: "搜索乐谱" })).toHaveValue("春日");
      expect(screen.queryByText("正在打开云盘…")).not.toBeInTheDocument();
      await waitFor(() => expect(restoredAfterListCommit).toBe(true));
    } finally {
      if (originalScrollTop) Object.defineProperty(root, "scrollTop", originalScrollTop);
      else Reflect.deleteProperty(root, "scrollTop");
    }
  });

  it("reuses the home summary while one member bootstrap loads the drive", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const ownerKey = driveCacheOwnerKey("user-1", "choir-1");
    rememberDriveSummary(ownerKey, {
      id: "choir-1",
      name: "已知云盘名称",
      guestAdmissionMode: "invite",
    });
    let finishBootstrap!: (response: Response) => void;
    const bootstrap = new Promise<Response>((resolve) => {
      finishBootstrap = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/choirs/choir-1/bootstrap") return bootstrap;
      if (input === "/api/guest/session" && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "已知云盘名称" }),
    ).toBeInTheDocument();
    expect(screen.getByText("正在加载乐谱…")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => input).filter(input => input !== "/api/choirs")).toEqual([
      "/api/choirs/choir-1/bootstrap",
    ]);

    finishBootstrap(Response.json(driveBootstrapBody({ access: "membership" })));
    expect(await screen.findByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", expect.objectContaining({ method: "DELETE" }));
  });

  it("keeps immediate search on the latest query without racing network responses", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(driveBootstrapBody({
      scores: [
        { ...scoreListBody("初始结果.pdf").scores[0], id: "initial" },
        { ...scoreListBody("新结果.pdf").scores[0], id: "new" },
      ],
    }))));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/choirs/choir-1"]}><AppRoutes /></MemoryRouter>);
    await screen.findByRole("link", { name: /初始结果\.pdf/ });
    const searchbox = screen.getByRole("searchbox", { name: "搜索乐谱" });
    fireEvent.change(searchbox, { target: { value: "慢" } });
    expect(screen.getByText("找到 0 份，共 2 份乐谱")).toBeInTheDocument();
    expect(searchbox).toHaveValue("慢");
    fireEvent.change(searchbox, { target: { value: "新" } });
    expect(screen.getByRole("link", { name: /新结果\.pdf/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /初始结果\.pdf/ })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("?q="))).toBe(false);
    fireEvent.change(searchbox, { target: { value: "不存在" } });
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.getByRole("link", { name: /初始结果\.pdf/ })).toBeInTheDocument();
  });

  it("uploads files independently and reports invalid and duplicate files in place", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const uploadBodies: FormData[] = [];
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/choirs/choir-1/scores" && init?.method === "POST") {
        const form = init.body as FormData;
        uploadBodies.push(form);
        const file = form.get("file") as File;
        return Promise.resolve(
          file.name === "重复.pdf"
            ? Response.json({ error: "filename_conflict" }, { status: 409 })
            : Response.json({ score: scoreListBody(file.name).scores[0] }, { status: 201 }),
        );
      }
      if (input.includes("/bootstrap")) {
        return Promise.resolve(
          Response.json(driveBootstrapBody({ canManage: true, access: "membership" })),
        );
      }
      return Promise.resolve(
        Response.json({
          choir: {
            id: "choir-1",
            name: "小红花云盘",
            guestAdmissionMode: "invite",
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "上传 PDF" }));
    fireEvent.change(screen.getByLabelText("选择 PDF 文件"), {
      target: {
        files: [
          new File(["ok"], "练声.pdf", { type: "application/pdf" }),
          new File(["duplicate"], "重复.pdf", { type: "application/pdf" }),
          new File(["notes"], "说明.txt", { type: "text/plain" }),
        ],
      },
    });

    const statuses = await screen.findByRole("list", { name: "上传状态" });
    await waitFor(() => {
      expect(within(statuses).getByText("上传完成")).toBeInTheDocument();
      expect(within(statuses).getByText(/文件库已有同名文件/)).toBeInTheDocument();
      expect(within(statuses).getByText("只接受 PDF 文件。")).toBeInTheDocument();
    });
    expect(uploadBodies).toHaveLength(2);
    for (const body of uploadBodies) {
      expect(Array.from(body.keys())).toEqual(["file"]);
    }
  });

  it("requires explicit confirmation before logout discards pending work", async () => {
    await activateAuthenticatedLocalOwner("user-1");
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    await localDatabase.annotationOutbox.put({
      opId: "pending-op",
      ...localWorkspace,
      annotationId: "annotation-1",
      layerId: "layer-1",
      baseVersion: 0,
      type: "upsert",
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.1,
        y: 0.1, fontScale: 0.024,
        text: "待同步",
      },
      attemptedAt: null,
      createdAt: 1,
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("dialog", { name: "确认退出登录" })).toHaveTextContent(
      "本机还有 1 项待同步操作",
    );
    fireEvent.click(screen.getByRole("button", { name: "返回处理" }));
    expect(authClient.signOut).not.toHaveBeenCalled();
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });

  it("keeps local data when the server rejects logout", async () => {
    await activateAuthenticatedLocalOwner("user-1");
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.mocked(authClient.signOut).mockResolvedValueOnce({
      data: null,
      error: { status: 503, statusText: "Service Unavailable" },
    } as Awaited<ReturnType<typeof authClient.signOut>>);
    await localDatabase.annotationLayers.put({
      key: localWorkspaceRecordKey(localWorkspace, "personal-layer"),
      ...localWorkspace,
      id: "personal-layer",
      kind: "personal",
      sharedSlot: null,
      name: "我的批注",
      sortOrder: 10_000,
      subscribed: true,
      subscriptionSource: "product",
      displayColor: "#b4235a",
      colorSource: "product",
      adminDefaultColor: "#b4235a",
      driveSubscribed: null,
      driveColorOverride: null,
      scoreSubscriptionOverride: null,
      canEdit: true,
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "退出并清除" }),
    );

    expect(
      await screen.findByText("退出未完成，本机数据没有清除。请重试。"),
    ).toBeInTheDocument();
    expect(await localDatabase.annotationLayers.count()).toBe(1);
  });
});

function scoreListBody(fileName: string) {
  return {
    scores: [
      {
        id: `score-${fileName}`,
        choirId: "choir-1",
        fileName,
        updatedAt: 1,
        currentVersion: {
          id: `version-${fileName}`,
          versionNumber: 1,
          sizeBytes: 2048,
          sha256: "a".repeat(64),
          etag: '"etag"',
          pageCount: 2,
          createdAt: 1,
        },
      },
    ],
    storage: { usedBytes: 2048, limitBytes: 1_073_741_824 },
    permissions: { canManage: false },
  };
}

function driveBootstrapBody(options: {
  choir?: { id: string; name: string; guestAdmissionMode: "invite" | "open" };
  scores?: ReturnType<typeof scoreListBody>["scores"];
  usedBytes?: number;
  canManage?: boolean;
  access?: "membership" | "preview" | "guest";
} = {}) {
  return {
    choir: options.choir ?? {
      id: "choir-1",
      name: "小红花云盘",
      guestAdmissionMode: "invite" as const,
    },
    scores: options.scores ?? [],
    storage: {
      usedBytes: options.usedBytes ?? 0,
      limitBytes: 1_073_741_824,
    },
    permissions: {
      canManage: options.canManage ?? false,
      access: options.access ?? "guest",
    },
  };
}
