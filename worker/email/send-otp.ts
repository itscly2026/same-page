import { Resend } from "resend";

import type { Env } from "../env";

export async function sendSignInOtp(
  env: Pick<Env, "AUTH_EMAIL_FROM" | "RESEND_API_KEY">,
  email: string,
  otp: string,
): Promise<void> {
  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.AUTH_EMAIL_FROM,
    to: email,
    subject: `${otp} 是你的 Same Page 验证码`,
    text: `你的 Same Page 验证码是 ${otp}。验证码将在 10 分钟后失效。如果不是你本人操作，请忽略这封邮件。`,
    html: `<p>你的 Same Page 验证码是：</p><p style="font-size:32px;font-weight:700;letter-spacing:6px">${otp}</p><p>验证码将在 10 分钟后失效。如果不是你本人操作，请忽略这封邮件。</p>`,
  });

  if (error) {
    throw new Error("OTP delivery failed");
  }
}
