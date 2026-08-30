import { Resend } from "resend";

import type { Env } from "../env";

export type AuthOtpPurpose = "registration" | "forget-password";

export async function sendAuthOtp(
  env: Pick<Env, "AUTH_EMAIL_FROM" | "RESEND_API_KEY">,
  email: string,
  otp: string,
  purpose: AuthOtpPurpose,
): Promise<void> {
  const action =
    purpose === "registration" ? "完成 Same Page 注册" : "重设 Same Page 密码";
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.AUTH_EMAIL_FROM,
    to: email,
    subject: `${otp} 用于${action}`,
    text: `使用验证码 ${otp} ${action}。验证码将在 10 分钟后失效。如果不是你本人操作，请忽略这封邮件。`,
    html: `<p>使用以下验证码${action}：</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${otp}</p><p>验证码将在 10 分钟后失效。如果不是你本人操作，请忽略这封邮件。</p>`,
  });

  if (error) {
    throw new Error("OTP delivery failed");
  }
}
