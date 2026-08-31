import type { Context } from "hono";

import type { AppEnvironment } from "../env";
import { createAuth } from "./create-auth";
import {
  completeRegistration,
  requestRegistrationOtp,
  resolveAuthFlow,
} from "./registration";

const OTP_SIGN_IN_PATH = "/api/auth/sign-in/email-otp";
const SEND_OTP_PATH = "/api/auth/email-otp/send-verification-otp";
const VERIFY_EMAIL_PATH = "/api/auth/email-otp/verify-email";
const SIGN_UP_PATH = "/api/auth/sign-up/email";
const REGISTRATION_REQUEST_PATH = "/api/auth/registration/request-otp";
const REGISTRATION_COMPLETE_PATH = "/api/auth/registration/complete";
const AUTH_FLOW_PATH = "/api/auth/flow";

export async function handleAuthRequest(context: Context<AppEnvironment>) {
  const path = normalizedPathname(context.req.url);

  if (path === AUTH_FLOW_PATH && context.req.method === "POST") {
    return resolveAuthFlow(context);
  }
  const auth = createAuth(context.env, context.executionCtx);

  if (path === REGISTRATION_REQUEST_PATH && context.req.method === "POST") {
    return requestRegistrationOtp(context, auth);
  }
  if (path === REGISTRATION_COMPLETE_PATH && context.req.method === "POST") {
    return completeRegistration(context, auth);
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
