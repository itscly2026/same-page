import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
          input === "/api/guest/preview-choir"
            ? Response.json({}, { status: 404 })
            : Response.json(
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
    expect(screen.getByRole("link", { name: "登录或注册" })).toBeInTheDocument();
    expect(screen.queryByLabelText("八位邀请码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "进入合唱团" }));
    expect(screen.getByRole("dialog", { name: "进入合唱团" })).toBeInTheDocument();
    expect(screen.getByLabelText("八位邀请码")).toBeInTheDocument();
    expect(screen.getByText("无需注册，也可以访客身份只读访问。")).toBeInTheDocument();
    expect(screen.queryByText("创建合唱团")).not.toBeInTheDocument();
    expect(screen.queryByText("公开合唱团")).not.toBeInTheDocument();
  });

  it("exposes the preview choir through the single signed-out entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({
                choir: {
                  id: "preview-choir",
                  name: "公开合唱团",
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

    expect(await screen.findByRole("link", { name: "抢先体验" })).toHaveAttribute(
      "href",
      "/choirs/preview-choir",
    );
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

  it("shows a signed-in user with no memberships how to join one", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "进入合唱团" }));
    expect(await screen.findByRole("heading", { name: "使用邀请码加入" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "我的合唱团" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("团内显示名")).toBeInTheDocument();
  });

  it("shows a signed-in user's single membership without skipping the entry dialog", async () => {
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
    expect(screen.getByRole("heading", { name: "使用邀请码加入" })).toBeInTheDocument();
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
                name: "公开合唱团",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
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

    expect(await screen.findByText("这里还没有 PDF 文件。")).toBeInTheDocument();
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

    expect(await screen.findByText("这里还没有 PDF 文件。")).toBeInTheDocument();
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

  it("returns a signed-in non-member from the preview choir to the home entry", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (
          input === "/api/guest/preview-choir" ||
          input === "/api/guest/choirs/preview-choir"
        ) {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "preview-choir",
                name: "公开合唱团",
                guestAdmissionMode: "open",
              },
              entryKind: "preview",
            }),
          );
        }
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        return Promise.resolve(Response.json({}, { status: 403 }));
      }),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/preview-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Every voice, on the same page.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("团内显示名")).not.toBeInTheDocument();
    expect(screen.queryByText("公开合唱团")).not.toBeInTheDocument();
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
      await screen.findByText("邀请码已轮换。请现在复制并通过私密渠道发送。"),
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
            storage: { usedBytes: 900_000_000, limitBytes: 1_073_741_824 },
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
      await screen.findByRole("button", { name: "上传 PDF" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/团存储已使用 858\.3 MB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(await screen.findByRole("menuitem", { name: /团存储：858\.3 MB/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "回收站" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "轮换邀请码" }),
    ).not.toBeInTheDocument();
  });

  it("shows members a filename-first list without administrator storage controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input.includes("/scores")
            ? Response.json({
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
                permissions: { canManage: false },
              })
            : Response.json({
                choir: {
                  id: "choir-1",
                  name: "小红花合唱团",
                  guestAdmissionMode: "invite",
                },
              }),
        ),
      ),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: /排练 10\.pdf.*2\.0 MB/ })).toHaveAttribute(
      "href",
      "/choirs/choir-1/scores/score-10",
    );
    expect(screen.queryByRole("button", { name: "上传 PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回收站" })).not.toBeInTheDocument();
    expect(screen.queryByText(/团存储已使用/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/更多操作/)).not.toBeInTheDocument();
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
            : Response.json({}, { status: 201 }),
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
      defaultSlot: null,
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
