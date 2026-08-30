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
      vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 401 })),
      ),
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

  it("signs in with a normalized email and password without requesting an OTP", async () => {
    renderAuthPage();

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "Singer@Example.Test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    const loginButton = screen.getByRole("button", { name: "登录" });
    await vi.waitFor(() => expect(loginButton).toBeEnabled());
    fireEvent.click(loginButton);

    await vi.waitFor(() => {
      expect(authClient.signIn.email).toHaveBeenCalledWith({
        email: "singer@example.test",
        password: "correct horse battery staple",
      });
    });
  });

  it("waits for guest-session discovery before allowing password sign-in", async () => {
    let resolveGuestSession!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "/api/guest/session") {
        return new Promise<Response>((resolve) => {
          resolveGuestSession = resolve;
        });
      }
      return Promise.resolve(Response.json({ membership: { id: "member-1" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAuthPage();

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "singer@example.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    const loginButton = screen.getByRole("button", { name: "登录" });
    expect(loginButton).toBeDisabled();
    fireEvent.click(loginButton);
    expect(authClient.signIn.email).not.toHaveBeenCalled();

    resolveGuestSession(
      Response.json({ choir: { id: "choir-1", name: "小红花合唱团" } }),
    );
    await screen.findByText("登录后，你将以成员身份加入“小红花合唱团”。");
    fireEvent.change(screen.getByLabelText("团内显示名"), {
      target: { value: "小花" },
    });
    fireEvent.click(loginButton);

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

  it("verifies a new registration before upgrading an active guest session", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "/api/guest/session") {
        return Promise.resolve(
          Response.json({
            choir: { id: "choir-1", name: "小红花合唱团" },
          }),
        );
      }
      if (
        input === "/api/auth/registration/request-otp" ||
        input === "/api/auth/registration/complete"
      ) {
        return Promise.resolve(Response.json({ success: true }));
      }
      return Promise.resolve(Response.json({ membership: { id: "member-1" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAuthPage();

    await screen.findByText("登录后，你将以成员身份加入“小红花合唱团”。");
    fireEvent.click(screen.getByRole("button", { name: "注册" }));
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "New@Example.Test" },
    });
    fireEvent.change(screen.getByLabelText("密码（至少 10 位）"), {
      target: { value: "new secure password" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "new secure password" },
    });
    fireEvent.change(screen.getByLabelText("团内显示名"), {
      target: { value: "小花" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "注册并发送验证码" }),
    );

    expect(await screen.findByLabelText("六位验证码")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/registration/request-otp",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "new@example.test" }),
      }),
    );

    fireEvent.change(screen.getByLabelText("六位验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "完成注册" }));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/auth/registration/complete",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "new@example.test",
            otp: "123456",
            password: "new secure password",
          }),
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/choirs/join-current-guest",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ displayName: "小花" }),
        }),
      );
    });
  });

  it("sets or resets a password with an OTP and then uses password sign-in", async () => {
    renderAuthPage();

    fireEvent.click(
      screen.getByRole("button", { name: "首次设置或忘记密码" }),
    );
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "Admin@Example.Test" },
    });
    const resetRequestButton = screen.getByRole("button", {
      name: "发送密码重置验证码",
    });
    await vi.waitFor(() => expect(resetRequestButton).toBeEnabled());
    fireEvent.click(resetRequestButton);

    expect(await screen.findByLabelText("六位验证码")).toBeInTheDocument();
    expect(authClient.emailOtp.requestPasswordReset).toHaveBeenCalledWith({
      email: "admin@example.test",
    });

    fireEvent.change(screen.getByLabelText("六位验证码"), {
      target: { value: "654321" },
    });
    fireEvent.change(screen.getByLabelText("新密码（至少 10 位）"), {
      target: { value: "replacement password" },
    });
    fireEvent.change(screen.getByLabelText("确认新密码"), {
      target: { value: "replacement password" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "重设密码并登录" }),
    );

    await vi.waitFor(() => {
      expect(authClient.emailOtp.resetPassword).toHaveBeenCalledWith({
        email: "admin@example.test",
        otp: "654321",
        password: "replacement password",
      });
      expect(authClient.signIn.email).toHaveBeenCalledWith({
        email: "admin@example.test",
        password: "replacement password",
      });
    });
  });
});

function renderAuthPage() {
  render(
    <MemoryRouter>
      <AuthPage />
    </MemoryRouter>,
  );
}
