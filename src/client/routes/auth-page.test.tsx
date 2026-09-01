import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
            Response.json({ providers: ["google", "wechat"] }),
          );
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
    sessionStorage.clear();
  });

  it("keeps email primary and routes an existing user to password sign-in", async () => {
    renderAuthPage();

    const emailField = screen.getByLabelText("邮箱");
    expect(emailField).toHaveFocus();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
    expect(screen.queryByText("忘记密码")).not.toBeInTheDocument();
    expect(screen.queryByText("显示名")).not.toBeInTheDocument();
    const emailSubmit = screen.getByRole("button", { name: "登录或注册" });
    const google = await screen.findByRole("button", {
      name: "使用 Google 继续",
    });
    expect(screen.getByRole("button", { name: "使用微信继续" })).toBeInTheDocument();
    expect(
      emailSubmit.compareDocumentPosition(google) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

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
      await screen.findByRole("button", { name: "使用微信继续" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "暂时无法开始第三方登录，请重试或继续使用邮箱。",
    );
    expect(screen.getByLabelText("邮箱")).toHaveValue("singer@example.test");
    expect(screen.getByRole("button", { name: "登录或注册" })).toBeEnabled();
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
  });

  it("continues an invitation to display-name collection after social authentication", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input === "/api/auth/social-providers") {
          return Promise.resolve(Response.json({ providers: ["wechat"] }));
        }
        if (input === "/api/auth/get-session") {
          return Promise.resolve(
            Response.json({ user: { id: "wechat-user" } }),
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
          return Promise.resolve(Response.json({ providers: ["wechat"] }));
        }
        if (input === "/api/auth/get-session") {
          return Promise.resolve(Response.json({ user: { id: "wechat-user" } }));
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
      "该成员关系需要云盘管理员恢复",
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
