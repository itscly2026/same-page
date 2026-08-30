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
              : { choir: { id: "choir-1", name: "小红花合唱团" } },
          ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with a read-only guest entry and no public choir creation", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "让每次排练，都在同一页" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("八位邀请码")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "访客进入" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("创建合唱团")).not.toBeInTheDocument();
  });

  it("uses the guest session response to enter a choir", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("八位邀请码"), {
      target: { value: "AAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "访客进入" }));

    expect(
      await screen.findByRole("heading", { name: "小红花合唱团" }),
    ).toBeInTheDocument();
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
            Response.json({ joinCode: "ABCDEFGH", joinCodeVersion: 2 }),
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
          Response.json({ choir: { id: "choir-1", name: "小红花合唱团" } }),
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
