import type { Context } from "hono";

import type { AppEnvironment } from "../env";
import { createAuth } from "./create-auth";
import {
  completeRegistration,
  requestPasswordResetOtp,
  requestRegistrationOtp,
  resolveAuthFlow,
} from "./registration";
import { configuredSocialProviderIds } from "./social-providers";

const OTP_SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
const SEND_OTP_PATH = "/api/auth/email-otp/send-verification-otp";
const VERIFY_EMAIL_PATH = "/api/auth/email-otp/verify-email";
const SIGN_UP_PATH = "/api/auth/sign-up/email";
const REGISTRATION_REQUEST_PATH = "/api/auth/registration/request-otp";
const REGISTRATION_COMPLETE_PATH = "/api/auth/registration/complete";
const PASSWORD_RESET_REQUEST_PATH =
  "/api/auth/email-otp/request-password-reset";
const AUTH_FLOW_PATH = "/api/auth/flow";
const SOCIAL_PROVIDERS_PATH = "/api/auth/social-providers";

export async function handleAuthRequest(context: Context<AppEnvironment>) {
  const path = normalizedPathname(context.req.url);

  if (path === AUTH_FLOW_PATH && context.req.method === "POST") {
    return resolveAuthFlow(context);
  }
  if (path === SOCIAL_PROVIDERS_PATH) {
    if (context.req.method !== "GET") {
      return context.json({ error: "method_not_allowed" }, 405);
    }
    context.header("Cache-Control", "no-store");
    return context.json({
      providers: configuredSocialProviderIds(context.env),
    });
  }
  const auth = createAuth(context.env, context.executionCtx);

  if (path === REGISTRATION_REQUEST_PATH && context.req.method === "POST") {
    return requestRegistrationOtp(context, auth);
  }
  if (path === REGISTRATION_COMPLETE_PATH && context.req.method === "POST") {
    return completeRegistration(context, auth);
  }
  if (path === PASSWORD_RESET_REQUEST_PATH && context.req.method === "POST") {
    return requestPasswordResetOtp(context, auth);
  }

  if (
    path === OTP_SIGN_IN_PATH ||
    path === SEND_OTP_PATH ||
    path === VERIFY_EMAIL_PATH ||
    path === SIGN_UP_PATH
  ) {
    return context.json({ error: "not_found" }, 404);
  }
  // A newly verified deleted identity holds only a recovery session. Product
  // authorization also rejects it, including guest fallback from a stale cookie.
  const session = await auth.api.getSession({ headers: context.req.raw.headers });
  if (session && await context.env.DB.prepare("SELECT user_id FROM user_lifecycle WHERE user_id = ?").bind(session.user.id).first()) {
    if (path === "/api/auth/get-session") return context.json(null);
    if (path !== "/api/auth/sign-out" && !path.startsWith("/api/auth/sign-in/") && !path.startsWith("/api/auth/callback/")) {
      return context.json({ error: "user_pending_deletion" }, 403);
    }
  }
  return auth.handler(context.req.raw);
}

function normalizedPathname(url: string) {
  const pathname = new URL(url).pathname;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}
