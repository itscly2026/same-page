import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./app";
import { authClient } from "./auth/auth-client";
import { localDatabase } from "./platform/local-database";

vi.mock("./auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
    signOut: vi.fn(),
  },
}));

describe("AppRoutes", () => {
  beforeEach(async () => {
    await localDatabase.open();
    vi.mocked(authClient.useSession).mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          Response.json(
            input === "/api/choirs"
              ? { memberships: [] }
              : input.includes("/scores")
              ? {
                  scores: [],
                  storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
                  permissions: { canManage: false },
                }
              : {
                  choir: {
                    id: "choir-1",
                    name: "小红花合唱团",
                    guestAdmissionMode: "invite",
                  },
                },
          ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with the branded entry and keeps guest admission inside one dialog", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Every voice, on the same page." }),
    ).toBeInTheDocument();
    expect(screen.getByText("同页共谱，众声一心。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录 / 注册" })).toBeInTheDocument();
    expect(screen.queryByLabelText("八位邀请码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入合唱团" }));
    expect(screen.getByRole("dialog", { name: "进入合唱团" })).toBeInTheDocument();
    expect(screen.getByLabelText("八位邀请码")).toBeInTheDocument();
    expect(screen.getByText("无需注册，也可以访客身份只读访问。")).toBeInTheDocument();
    expect(screen.queryByText("创建合唱团")).not.toBeInTheDocument();
    expect(screen.queryByText("公开合唱团")).not.toBeInTheDocument();
  });

  it("uses the guest session response to enter a choir", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "进入合唱团" }));
    fireEvent.change(screen.getByLabelText("八位邀请码"), {
      target: { value: "AAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByRole("heading", { name: "小红花合唱团" }),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "invite", joinCode: "AAAAAAAA" }),
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

    fireEvent.click(screen.getByRole("button", { name: "进入合唱团" }));
    fireEvent.change(screen.getByLabelText("八位邀请码"), {
      target: { value: "AAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("邀请码无效或已失效。");
    expect(screen.getByRole("dialog", { name: "进入合唱团" })).toBeInTheDocument();
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
                name: "小红花合唱团",
                guestAdmissionMode: "invite",
              },
            },
            {
              id: "membership-2",
              displayName: "Alto",
              role: "member",
              choir: {
                id: "choir-2",
                name: "周末合唱团",
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

    fireEvent.click(screen.getByRole("button", { name: "进入合唱团" }));
    expect(await screen.findByRole("link", { name: /小红花合唱团.*小花/ })).toHaveAttribute(
      "href",
      "/choirs/choir-1",
    );
    expect(screen.getByRole("link", { name: /周末合唱团.*Alto/ })).toHaveAttribute(
      "href",
      "/choirs/choir-2",
    );
    expect(screen.getByLabelText("团内显示名")).toBeInTheDocument();
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
                name: "公开合唱团",
                guestAdmissionMode: "open",
              },
            }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          admitted = true;
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开合唱团",
                guestAdmissionMode: "open",
              },
            }),
          );
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input.includes("/scores")) {
          return Promise.resolve(
            admitted
              ? Response.json({
                  scores: [],
                  storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
                  permissions: { canManage: false },
                })
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

    expect(
      await screen.findByRole("heading", { name: "公开合唱团" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId: "spring-choir" }),
    });
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
                name: "公开合唱团",
                guestAdmissionMode: "open",
              },
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
                    name: "公开合唱团",
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
                        name: "公开合唱团",
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
        return Promise.resolve(
          joined
            ? Response.json({
                scores: [],
                storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
                permissions: { canManage: false },
              })
            : Response.json({}, { status: 403 }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.change(
      await screen.findByLabelText("团内显示名"),
      { target: { value: "小花" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "加入并进入" }));

    expect(
      await screen.findByRole("heading", { name: "公开合唱团" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/choirs/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        admission: "open",
        choirId: "spring-choir",
        displayName: "小花",
      }),
    });
  });

  it("lets an administrator rotate and then hide a one-time join code", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input.endsWith("/join-code/rotate") && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ joinCode: "ABCDEFGH" }),
          );
        }
        if (input.includes("/scores")) {
          return Promise.resolve(
            Response.json({
              scores: [],
              storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
              permissions: { canManage: true },
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            choir: {
              id: "choir-1",
              name: "小红花合唱团",
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

    fireEvent.click(
      await screen.findByRole("button", { name: "轮换邀请码" }),
    );

    expect(
      await screen.findByText("邀请码已轮换。请现在复制新邀请码并通过私密渠道发送。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("新的八位邀请码")).toHaveTextContent(
      "ABCDEFGH",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/choirs/choir-1/join-code/rotate",
      { method: "POST" },
    );

    fireEvent.click(screen.getByRole("button", { name: "已复制，隐藏邀请码" }));
    expect(screen.queryByLabelText("新的八位邀请码")).not.toBeInTheDocument();
  });

  it("keeps management tools but hides invite-code controls for open guest admission", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes("/scores")) {
        return Promise.resolve(
          Response.json({
            scores: [],
            storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
            permissions: { canManage: true },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          choir: {
            id: "spring-choir",
            name: "公开合唱团",
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
      await screen.findByRole("heading", { name: "上传新乐谱" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "轮换邀请码" }),
    ).not.toBeInTheDocument();
  });

  it("requires explicit confirmation before logout discards pending work", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    await localDatabase.annotationOutbox.put({
      opId: "pending-op",
      scopeKey: "choir-1:score-1",
      choirId: "choir-1",
      scoreId: "score-1",
      annotationId: "annotation-1",
      layerId: "layer-1",
      baseVersion: 0,
      type: "upsert",
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.1,
        y: 0.1,
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
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.mocked(authClient.signOut).mockResolvedValueOnce({
      data: null,
      error: { status: 503, statusText: "Service Unavailable" },
    } as Awaited<ReturnType<typeof authClient.signOut>>);
    await localDatabase.annotationLayers.put({
      key: "choir-1:score-1:personal-layer",
      scopeKey: "choir-1:score-1",
      id: "personal-layer",
      kind: "personal",
      name: "我的批注",
      sortOrder: 10_000,
      defaultColor: "#b4235a",
      colorOverride: null,
      visible: true,
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
