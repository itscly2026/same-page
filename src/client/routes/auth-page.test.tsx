import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authClient } from "../auth/auth-client";
import AuthPage from "./auth-page";

vi.mock("../auth/auth-client", () => ({
  authClient: {
    emailOtp: {
      sendVerificationOtp: vi.fn(),
    },
    signIn: {
      emailOtp: vi.fn(),
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
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
      data: { success: true },
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses a registration-neutral message after requesting an OTP", async () => {
    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "Singer@Example.Test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

    expect(
      await screen.findByText(
        "如果邮件地址可用，验证码已经发送。请检查收件箱和垃圾邮件。",
      ),
    ).toBeInTheDocument();
    expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
      email: "singer@example.test",
      type: "sign-in",
    });
    expect(screen.getByLabelText("六位验证码")).toBeInTheDocument();
  });

  it("upgrades an active guest session after OTP verification", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "/api/guest/session") {
        return Promise.resolve(
          Response.json({
            choir: { id: "choir-1", name: "小红花合唱团" },
          }),
        );
      }
      return Promise.resolve(Response.json({ membership: { id: "member-1" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({
      data: { token: "session", user: {} },
      error: null,
    });

    render(
      <MemoryRouter>
        <AuthPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        "验证邮箱后，你将以成员身份加入“小红花合唱团”。",
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "member@example.test" },
    });
    fireEvent.change(screen.getByLabelText("团内显示名"), {
      target: { value: "小花" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));
    await screen.findByLabelText("六位验证码");
    fireEvent.change(screen.getByLabelText("六位验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

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
});
