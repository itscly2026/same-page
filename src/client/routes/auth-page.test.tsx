import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authClient } from "../auth/auth-client";
import AuthPage from "./auth-page";

vi.mock("../auth/auth-client", () => ({
  authClient: {
    emailOtp: {
      resetPassword: vi.fn(),
    },
    signIn: {
      email: vi.fn(),
      social: vi.fn(),
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
        if (input === "/api/auth/social-providers") {
          return Promise.resolve(
            Response.json({ providers: ["google"] }),
          );
        }
        if (input === "/api/auth/email-otp/request-password-reset") {
          return Promise.resolve(Response.json({ success: true }));
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
    vi.mocked(authClient.signIn.social).mockResolvedValue({
      data: {
        redirect: true,
        url: "https://accounts.google.com/o/oauth2/v2/auth",
      },
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
    sessionStorage.clear();
  });

  it.each(["google"])("routes a restricted %s recovery session to explicit restoration", async (provider) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/api/user/lifecycle") return Response.json({ deletion: { authMethod: provider, deletionId: "deletion", expiresAt: Date.now() + 10000 } });
      if (input === "/api/auth/get-session") return Response.json(null);
      if (input === "/api/auth/social-providers") return Response.json({ providers: ["google"] });
      return new Response(null, { status: 404 });
    }));
    renderAuthPage("/login?oauth=complete");
    expect(await screen.findByLabelText("current route")).toHaveTextContent("/user/lifecycle");
  });

  it.each(["none", "preview", "joined"])("returns a reader login to the requested score with %s admission", async admission => {
    const previous = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (admission !== "none" && input === "/api/guest/session" && !init?.method) return Response.json({ choir: { id: "drive", name: "排练", guestAdmissionMode: "open" }, entryKind: admission === "preview" ? "preview" : "admission" });
      if (input === "/api/choirs/current-guest/join-state") return Response.json({ status: "joined", choir: { id: "drive", name: "排练", guestAdmissionMode: "open" } });
      return previous(input, init);
    });
    renderAuthPage("/login?returnTo=%2Fchoirs%2Fdrive%2Fscores%2Fscore&panel=layers");
    await identify("singer@example.test");
    fireEvent.change(await screen.findByLabelText("密码"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByLabelText("current route")).toHaveTextContent("/choirs/drive/scores/score");
  });

  it("lets a guest cancel login and continue the requested score", async () => {
    renderAuthPage("/login?returnTo=%2Fchoirs%2Fdrive%2Fscores%2Fscore");
    fireEvent.click(screen.getByRole("button", { name: "继续只读浏览" }));
    expect(await screen.findByLabelText("current route")).toHaveTextContent("/choirs/drive/scores/score");
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/guest/session" && init?.method === "DELETE")).toBe(false);
  });

  it("keeps email primary and routes an existing user to password sign-in", async () => {
    renderAuthPage();

    const emailField = screen.getByLabelText("邮箱");
    expect(emailField).toHaveFocus();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByText("忘记密码")).not.toBeInTheDocument();
    expect(screen.queryByText("显示名")).not.toBeInTheDocument();
    const emailSubmit = screen.getByRole("button", { name: "继续" });
    const google = await screen.findByRole("button", {
      name: "使用 Google 继续",
    });
    expect(
      emailSubmit.compareDocumentPosition(google) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.change(emailField, {
      target: { value: "Singer@Example.Test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

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

    expect(screen.getByRole("button", { name: "使用 Google 继续" })).toBeEnabled();
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

  it("verifies a Google user's mailbox before choosing a Same Page password and continues after automatic login", async () => {
    const fetchMock = vi.mocked(fetch);
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (input === "/api/auth/flow") return Response.json({ flow: "set-password", hasGoogle: true });
      if (input === "/api/auth/email-otp/check-verification-otp" || input === "/api/auth/email-otp/reset-password") return Response.json({ success: true });
      return originalFetch(input, init);
    });
    renderAuthPage();
    await identify("google@example.test");
    expect(await screen.findByText("你此前通过 Google 登录，尚未设置合谱密码")).toBeInTheDocument();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "忘记密码" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 Google 继续" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "设置密码，以后用邮箱登录" }));
    fireEvent.change(await screen.findByLabelText("六位验证码"), { target: { value: "123456" } });
    expect(screen.queryByLabelText("密码（至少 10 位）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "验证邮箱" }));
    fireEvent.change(await screen.findByLabelText("密码（至少 10 位）"), { target: { value: "my new Same Page password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "my new Same Page password" } });
    fireEvent.click(screen.getByRole("button", { name: "设置密码并登录" }));
    expect(await screen.findByText("密码已设置，以后可以使用邮箱密码或 Google 登录")).toBeInTheDocument();
    expect(authClient.signIn.email).toHaveBeenCalledWith({ email: "google@example.test", password: "my new Same Page password" });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(await screen.findByLabelText("current route")).toHaveTextContent("/");
  });

  it.each(["sign-in", "set-password"])("hides unavailable Google on the %s screen", async (flow) => {
    mockFirstPasswordFlow(async (input) => {
      if (input === "/api/auth/flow") return Response.json(flow === "set-password" ? { flow, hasGoogle: true } : { flow });
      if (input === "/api/auth/social-providers") return Response.json({ providers: [] });
    });
    renderAuthPage();
    await identify("google@example.test");
    await screen.findByRole("heading", { name: flow === "sign-in" ? "登录" : "使用 Google 登录" });
    expect(screen.queryByRole("button", { name: "使用 Google 继续" })).not.toBeInTheDocument();
    if (flow === "set-password") expect(screen.getByRole("button", { name: "设置密码，以后用邮箱登录" })).toBeEnabled();
  });

  it("recovers a lost OTP delivery response through cooldown without entering registration", async () => {
    let requests = 0;
    mockFirstPasswordFlow(async (input) => {
      if (input === "/api/auth/email-otp/request-password-reset") {
        if (++requests === 1) throw new TypeError("Network failure");
        return Response.json({}, { status: 429, headers: { "Retry-After": "42" } });
      }
    });
    renderAuthPage();
    await identify("google@example.test");
    fireEvent.click(await screen.findByRole("button", { name: "设置密码，以后用邮箱登录" }));
    expect(await screen.findByRole("status")).toHaveTextContent("暂时无法发送验证码");
    fireEvent.click(screen.getByRole("button", { name: "设置密码，以后用邮箱登录" }));
    expect(await screen.findByLabelText("六位验证码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新发送验证码（42 秒）" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("已收到的验证码仍可使用");
    fireEvent.click(screen.getByRole("button", { name: "返回登录方式" }));
    expect(await screen.findByText("你此前通过 Google 登录，尚未设置合谱密码")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更换邮箱" }));
    expect(await screen.findByLabelText("邮箱")).toHaveValue("google@example.test");
  });

  it.each([400, 403, 429, 503, "network"])("keeps mailbox verification retryable after %s", async (failure) => {
    let checks = 0;
    mockFirstPasswordFlow(async (input) => {
      if (input === "/api/auth/email-otp/check-verification-otp" && ++checks === 1) {
        if (failure === "network") throw new TypeError("Network failure");
        return Response.json({}, { status: Number(failure) });
      }
    });
    renderAuthPage();
    await startFirstPassword();
    fireEvent.change(screen.getByLabelText("六位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "验证邮箱" }));
    await vi.waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(failure === 429 ? "尝试次数过多" : failure === 400 || failure === 403 ? "验证码错误、已过期或尝试次数已用尽" : "暂时无法验证"));
    expect(screen.queryByLabelText("密码（至少 10 位）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "验证邮箱" }));
    expect(await screen.findByLabelText("密码（至少 10 位）")).toBeInTheDocument();
  });

  it.each(["lost-response", "expired-code", "login-failed"])("recovers %s while setting the first password", async (failure) => {
    mockFirstPasswordFlow(async input => {
      if (input === "/api/auth/email-otp/reset-password") {
        if (failure === "lost-response") throw new TypeError("Network failure");
        if (failure === "expired-code") return Response.json({}, { status: 400 });
      }
    });
    if (failure === "login-failed") vi.mocked(authClient.signIn.email).mockRejectedValueOnce(new TypeError("Network failure"));
    renderAuthPage();
    await startFirstPassword();
    fireEvent.change(screen.getByLabelText("六位验证码"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "验证邮箱" }));
    fireEvent.change(await screen.findByLabelText("密码（至少 10 位）"), { target: { value: "new secure password" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "new secure password" } });
    fireEvent.click(screen.getByRole("button", { name: "设置密码并登录" }));
    if (failure === "expired-code") {
      expect(await screen.findByLabelText("六位验证码")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("请重新验证邮箱");
      expect(authClient.signIn.email).not.toHaveBeenCalled();
    } else if (failure === "login-failed") {
      expect(await screen.findByLabelText("密码")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("密码已设置，自动登录没有完成");
    } else {
      expect(await screen.findByText("密码已设置，以后可以使用邮箱密码或 Google 登录")).toBeInTheDocument();
    }
  });

  it("starts Google sign-in while preserving the typed email draft", async () => {
    renderAuthPage();

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "Singer@Example.Test" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 Google 继续" }),
    );

    await vi.waitFor(() => {
      expect(authClient.signIn.social).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/login?oauth=complete",
        errorCallbackURL: "/login?oauth=error",
      });
    });
    expect(sessionStorage.getItem("same-page:social-auth-email-draft")).toBe(
      "Singer@Example.Test",
    );
  });

  it("keeps email available when starting a social provider fails", async () => {
    vi.mocked(authClient.signIn.social).mockResolvedValueOnce({
      data: null,
      error: { status: 503, statusText: "Service Unavailable" },
    });
    renderAuthPage();

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "singer@example.test" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "使用 Google 继续" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "暂时无法开始第三方登录，请重试或继续使用邮箱。",
    );
    expect(screen.getByLabelText("邮箱")).toHaveValue("singer@example.test");
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
  });

  it("preserves the email draft when a social provider returns an error", async () => {
    sessionStorage.setItem(
      "same-page:social-auth-email-draft",
      "singer@example.test",
    );

    renderAuthPage("/login?oauth=error&error=access_denied");

    expect(screen.getByLabelText("邮箱")).toHaveValue("singer@example.test");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "第三方登录没有完成，请重试或继续使用邮箱。",
    );
  });

  it("runs the existing preview cleanup after social authentication", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/auth/social-providers") {
          return Promise.resolve(Response.json({ providers: ["google"] }));
        }
        if (input === "/api/auth/get-session") {
          return Promise.resolve(
            Response.json({ user: { id: "google-user" } }),
          );
        }
        if (input === "/api/guest/session" && !init?.method) {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "preview-choir",
                name: "公开体验云盘",
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

    renderAuthPage("/login?oauth=complete");

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", {
        method: "DELETE",
      });
    });
    expect(await screen.findByLabelText("current route")).toHaveTextContent("/choirs/preview-choir");
  });

  it("continues an invitation to display-name collection after social authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input === "/api/auth/social-providers") {
          return Promise.resolve(Response.json({ providers: ["google"] }));
        }
        if (input === "/api/auth/get-session") {
          return Promise.resolve(
            Response.json({ user: { id: "google-user" } }),
          );
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "choir-1",
                name: "小红花云盘",
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
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );

    renderAuthPage("/login?oauth=complete");

    expect(await screen.findByLabelText("显示名")).toBeInTheDocument();
    expect(screen.getByText(/认证已完成/)).toHaveTextContent("小红花云盘");
  });

  it("returns a normal social sign-in to the home route", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "/api/auth/social-providers") {
        return Promise.resolve(Response.json({ providers: ["google"] }));
      }
      if (input === "/api/auth/get-session") {
        return Promise.resolve(Response.json({ user: { id: "google-user" } }));
      }
      if (input === "/api/guest/session") {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAuthPage("/login?oauth=complete");

    expect(await screen.findByLabelText("current route")).toHaveTextContent("/");
  });

  it("enters the choir directly for an existing member after social authentication", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/auth/social-providers") {
          return Promise.resolve(Response.json({ providers: ["google"] }));
        }
        if (input === "/api/auth/get-session") {
          return Promise.resolve(Response.json({ user: { id: "google-user" } }));
        }
        if (input === "/api/guest/session" && !init?.method) {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({
              status: "joined",
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
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

    renderAuthPage("/login?oauth=complete");

    expect(await screen.findByLabelText("current route")).toHaveTextContent(
      "/choirs/choir-1",
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", {
      method: "DELETE",
    });
  });

  it("does not mutate guest context for a forged OAuth completion URL", async () => {
    sessionStorage.setItem(
      "same-page:social-auth-email-draft",
      "singer@example.test",
    );
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/auth/social-providers") {
          return Promise.resolve(Response.json({ providers: ["google"] }));
        }
        if (input === "/api/auth/get-session") {
          return Promise.resolve(Response.json(null));
        }
        if (input === "/api/guest/session" && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAuthPage("/login?oauth=complete");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "第三方登录没有建立有效会话，请重试或继续使用邮箱。",
    );
    expect(screen.getByLabelText("邮箱")).toHaveValue("singer@example.test");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/guest/session", {
      method: "DELETE",
    });
    expect(sessionStorage.getItem("same-page:social-auth-email-draft")).toBe(
      "singer@example.test",
    );
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
                name: "小红花云盘",
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
                name: "小红花云盘",
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
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
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

    const displayName = await screen.findByLabelText("显示名");
    expect(screen.getByText(/认证已完成/)).toHaveTextContent("小红花云盘");
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
                name: "公开体验云盘",
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
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("current route")).toHaveTextContent("/choirs/preview-choir");
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
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/email-otp/request-password-reset",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "admin@example.test" }),
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "重新发送验证码（60 秒）",
      }),
    ).toBeDisabled();
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
                name: "小红花云盘",
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
      "该成员关系需要有成员恢复权限的人恢复",
    );
  });
});

async function identify(email: string) {
  fireEvent.change(screen.getByLabelText("邮箱"), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
  await vi.waitFor(() => {
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/flow",
      expect.objectContaining({ method: "POST" }),
    );
  });
}

function renderAuthPage(initialEntry = "/login") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/login" element={<AuthPage />} />
        <Route path="*" element={<CurrentRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

function CurrentRoute() {
  const location = useLocation();
  return <output aria-label="current route">{location.pathname}</output>;
}

function mockFirstPasswordFlow(override: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined> = async () => undefined) {
  const fetchMock = vi.mocked(fetch);
  const originalFetch = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    const response = await override(input, init);
    if (response) return response;
    if (input === "/api/auth/flow") return Response.json({ flow: "set-password", hasGoogle: true });
    if (input === "/api/auth/email-otp/check-verification-otp" || input === "/api/auth/email-otp/reset-password") return Response.json({ success: true });
    return originalFetch(input, init);
  });
}

async function startFirstPassword() {
  await identify("google@example.test");
  fireEvent.click(await screen.findByRole("button", { name: "设置密码，以后用邮箱登录" }));
  await screen.findByLabelText("六位验证码");
}
