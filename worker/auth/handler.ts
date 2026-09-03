import type { Context } from "hono";

import { isInternalAuthEmail } from "../../src/shared/auth";
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
const EMAIL_AUTH_PATHS = new Set([
  "/api/auth/sign-in/email",
  PASSWORD_RESET_REQUEST_PATH,
  "/api/auth/email-otp/reset-password",
]);

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
  if (
    context.req.method === "POST" &&
    EMAIL_AUTH_PATHS.has(path) &&
    (await requestUsesInternalEmail(context))
  ) {
    return context.json({ error: "invalid_request" }, 400);
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
  return auth.handler(context.req.raw);
}

function normalizedPathname(url: string) {
  const pathname = new URL(url).pathname;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

async function requestUsesInternalEmail(context: Context<AppEnvironment>) {
  const body = await context.req.raw.clone().json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || !("email" in body)) return false;
  return (
    typeof body.email === "string" && isInternalAuthEmail(body.email)
  );
}
