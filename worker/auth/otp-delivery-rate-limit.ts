import type { Context } from "hono";

import { AUTH_OTP_COOLDOWN_SECONDS } from "../../src/shared/auth";
import type { AppEnvironment } from "../env";
import {
  consumeRateLimit,
  hashRateLimitIdentity,
} from "../security/rate-limit";

export const AUTH_OTP_WINDOW_SECONDS = 15 * 60;
export const AUTH_OTP_CLIENT_MAX = 10;

const AUTH_OTP_WINDOW_MS = AUTH_OTP_WINDOW_SECONDS * 1000;
const AUTH_OTP_EMAIL_MAX = 3;

export async function enforceAuthOtpDeliveryRateLimit(
  context: Context<AppEnvironment>,
  email: string,
) {
  const normalizedEmail = email.trim().toLowerCase();
  const clientIdentity =
    context.req.header("CF-Connecting-IP") ?? "local-development";
  const limits = [
    {
      identity: `auth-otp:email-cooldown:${normalizedEmail}`,
      maxAttempts: 1,
      windowMs: AUTH_OTP_COOLDOWN_SECONDS * 1000,
    },
    {
      identity: `auth-otp:email-window:${normalizedEmail}`,
      maxAttempts: AUTH_OTP_EMAIL_MAX,
      windowMs: AUTH_OTP_WINDOW_MS,
    },
    {
      identity: `auth-otp:client-window:${clientIdentity}`,
      maxAttempts: AUTH_OTP_CLIENT_MAX,
      windowMs: AUTH_OTP_WINDOW_MS,
    },
  ];

  for (const limit of limits) {
    const key = await hashRateLimitIdentity(
      limit.identity,
      context.env.INVITE_SECRET,
    );
    const result = await consumeRateLimit(context.env.DB, key, limit);
    if (!result.allowed) {
      context.header("Retry-After", String(result.retryAfterSeconds));
      return context.json({ error: "try_again_later" }, 429);
    }
  }

  return null;
}
