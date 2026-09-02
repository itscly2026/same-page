import { Resend } from "resend";

import { isInternalAuthEmail } from "../../src/shared/auth";
import type { Env } from "../env";

export type AuthOtpPurpose = "registration" | "forget-password";

export async function sendAuthOtp(
  env: Pick<Env, "AUTH_EMAIL_FROM" | "RESEND_API_KEY">,
  email: string,
  otp: string,
  purpose: AuthOtpPurpose,
): Promise<void> {
  if (isInternalAuthEmail(email)) {
    throw new Error("OTP delivery blocked for internal authentication email");
  }
  const message = buildAuthOtpEmail(otp, purpose);
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.AUTH_EMAIL_FROM,
    to: email,
    ...message,
  });

  if (error) {
    throw new Error("OTP delivery failed");
  }
}

export function buildAuthOtpEmail(otp: string, purpose: AuthOtpPurpose) {
  const isRegistration = purpose === "registration";
  const subject = isRegistration
    ? "Same Page 注册验证码"
    : "Same Page 密码重设验证码";
  const action = isRegistration ? "完成 Same Page 注册" : "重设 Same Page 密码";
  const noActionResult = isRegistration ? "注册不会完成" : "密码不会改变";

  return {
    subject,
    text: [
      `你正在 samepage.clyapps.com ${action}。`,
      "",
      `验证码：${otp}`,
      "",
      "验证码将在 10 分钟后失效，请勿转发给他人。",
      `如果不是你本人操作，无需处理；${noActionResult}。`,
    ].join("\n"),
    html: [
      `<p>你正在 <strong>samepage.clyapps.com</strong> ${action}。</p>`,
      `<p>验证码：</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${otp}</p>`,
      "<p>验证码将在 10 分钟后失效，请勿转发给他人。</p>",
      `<p>如果不是你本人操作，无需处理；${noActionResult}。</p>`,
    ].join(""),
  };
}
