import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authClient } from "../auth/auth-client";
import AuthPage from "./auth-page";

vi.mock("../auth/auth-client", () => ({
  authClient: {
    emailOtp: {
      requestPasswordReset: vi.fn(),
      resetPassword: vi.fn(),
    },
    signIn: {
      email: vi.fn(),
    },
  },
}));

describe("AuthPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) => {
        if (input === "/api/auth/flow") {
          return Promise.resolve(Response.json({ flow: "sign-in" }));
        }
        if (input === "/api/guest/session" && !init?.method) {
          return Promise.resolve(new Response(null, { status: 401 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: { token: "session", user: {} },
      error: null,
    });
    vi.mocked(authClient.emailOtp.requestPasswordReset).mockResolvedValue({
      data: { success: true },
      error: null,
    });
    vi.mocked(authClient.emailOtp.resetPassword).mockResolvedValue({
      data: { success: true },
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("starts with only email and routes an existing user to password sign-in", async () => {
    renderAuthPage();

    const emailField = screen.getByLabelText("邮箱");
    expect(emailField).toHaveFocus();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByText("忘记密码")).not.toBeInTheDocument();
    expect(screen.queryByText("团内显示名")).not.toBeInTheDocument();

    fireEvent.change(emailField, {
      target: { value: "Singer@Example.Test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录或注册" }));

    const passwordField = await screen.findByLabelText("密码");
    await vi.waitFor(() => {
      expect(screen.getByRole("heading", { name: "登录" })).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "忘记密码" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/flow",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "singer@example.test" }),
      }),
    );

    fireEvent.change(passwordField, {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await vi.waitFor(() => {
      expect(authClient.signIn.email).toHaveBeenCalledWith({
        email: "singer@example.test",
        password: "correct horse battery staple",
      });
    });
  });

  it("registers first and only then asks for an invite choir display name", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/auth/flow") {
          return Promise.resolve(Response.json({ flow: "sign-up" }));
        }
        if (
          input === "/api/auth/registration/request-otp" ||
          input === "/api/auth/registration/complete"
        ) {
          return Promise.resolve(Response.json({ success: true }));
        }
        if (input === "/api/guest/session" && !init?.method) {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "choir-1",
                name: "小红花合唱团",
                guestAdmissionMode: "invite",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({
              status: "display-name-required",
              choir: {
                id: "choir-1",
                name: "小红花合唱团",
                guestAdmissionMode: "invite",
              },
            }),
          );
        }
        if (input === "/api/choirs/join-current-guest") {
          return Promise.resolve(Response.json({ membership: { id: "member-1" } }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAuthPage();

    await identify("New@Example.Test");
    expect(await screen.findByRole("heading", { name: "注册" })).toBeInTheDocument();
    expect(screen.queryByLabelText("团内显示名")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("密码（至少 10 位）"), {
      target: { value: "new secure password" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "new secure password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

    fireEvent.change(await screen.findByLabelText("六位验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成注册" }));

    const displayName = await screen.findByLabelText("团内显示名");
    expect(screen.getByText(/认证已完成/)).toHaveTextContent("小红花合唱团");
    fireEvent.change(displayName, { target: { value: "小花" } });
    fireEvent.click(screen.getByRole("button", { name: "加入并进入" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/choirs/join-current-guest",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ displayName: "小花" }),
        }),
      );
    });
  });

  it("clears a preview guest session after login without offering membership", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/auth/flow") {
          return Promise.resolve(Response.json({ flow: "sign-in" }));
        }
        if (input === "/api/guest/session" && !init?.method) {
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
        if (input === "/api/guest/session" && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAuthPage();

    await identify("member@example.test");
    fireEvent.change(await screen.findByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", {
        method: "DELETE",
      });
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/choirs/join-current-guest",
      expect.anything(),
    );
    expect(screen.queryByLabelText("团内显示名")).not.toBeInTheDocument();
  });

  it("shows forgot password only after an existing email is identified", async () => {
    renderAuthPage();
    expect(screen.queryByRole("button", { name: "忘记密码" })).not.toBeInTheDocument();

    await identify("Admin@Example.Test");
    fireEvent.click(await screen.findByRole("button", { name: "忘记密码" }));
    await vi.waitFor(() => {
      expect(screen.getByRole("heading", { name: "忘记密码" })).toHaveFocus();
    });
    expect(screen.queryByLabelText("邮箱")).not.toBeInTheDocument();
    expect(screen.getByLabelText("邮箱：admin@example.test")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "发送密码重置验证码" }),
    );
    expect(await screen.findByLabelText("六位验证码")).toBeInTheDocument();
    expect(authClient.emailOtp.requestPasswordReset).toHaveBeenCalledWith({
      email: "admin@example.test",
    });
  });

  it("moves focus to the result heading when post-authentication joining fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) => {
        if (input === "/api/auth/flow") {
          return Promise.resolve(Response.json({ flow: "sign-in" }));
        }
        if (input === "/api/guest/session" && !init?.method) {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "choir-1",
                name: "小红花合唱团",
                guestAdmissionMode: "invite",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json(
              { error: "membership_requires_admin" },
              { status: 403 },
            ),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    renderAuthPage();

    await identify("member@example.test");
    fireEvent.change(await screen.findByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await vi.waitFor(() => {
      expect(screen.getByRole("heading", { name: "登录完成" })).toHaveFocus();
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "该成员关系需要团管理员恢复",
    );
  });
});

async function identify(email: string) {
  fireEvent.change(screen.getByLabelText("邮箱"), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录或注册" }));
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/flow",
      expect.objectContaining({ method: "POST" }),
    );
  });
}

function renderAuthPage() {
  render(
    <MemoryRouter>
      <AuthPage />
    </MemoryRouter>,
  );
}
