import { describe, expect, it } from "vitest";

import { buildAuthOtpEmail } from "./send-otp";

describe("authentication OTP email", () => {
  it.each([
    ["registration" as const, "Same Page 注册验证码", "完成 Same Page 注册"],
    [
      "forget-password" as const,
      "Same Page 密码重设验证码",
      "重设 Same Page 密码",
    ],
  ])("builds a stable multipart %s message", (purpose, subject, action) => {
    const message = buildAuthOtpEmail("123456", purpose);

    expect(message.subject).toBe(subject);
    expect(message.subject).not.toContain("123456");
    expect(message.text).toContain("验证码：123456");
    expect(message.html).toContain(">123456<");
    expect(message.text).toContain("samepage.clyapps.com");
    expect(message.text).toContain(action);
    expect(message.text).toContain("10 分钟");
    expect(message.html).not.toMatch(/<img|https?:\/\//);
  });
});
