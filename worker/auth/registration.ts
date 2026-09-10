import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { PASSWORD_POLICY } from "../../src/shared/auth";
import { createDatabase } from "../db/database";
import { account, user } from "../db/schema";
import type { AppEnvironment } from "../env";
import {
  consumeRateLimit,
  hashRateLimitIdentity,
} from "../security/rate-limit";
import type { Auth } from "./create-auth";
import { enforceAuthOtpDeliveryRateLimit } from "./otp-delivery-rate-limit";

const registrationRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email()),
});

const registrationCompletionSchema = registrationRequestSchema.extend({
  otp: z.string().regex(/^\d{6}$/),
  password: z
    .string()
    .min(PASSWORD_POLICY.minLength)
    .max(PASSWORD_POLICY.maxLength),
});

export async function resolveAuthFlow(context: Context<AppEnvironment>) {
  const body = await parseJson(context);
  const parsed = registrationRequestSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

  const email = normalizeEmail(parsed.data.email);
  const limited = await enforceAuthFlowRateLimit(context, email);
  if (limited) return limited;

  const existingUser = await findUserByEmail(context, email);
  context.header("Cache-Control", "no-store");
  if (!existingUser?.emailVerified) return context.json({ flow: "sign-up" });

  const identities = await createDatabase(context.env.DB).query.account.findMany({
    where: eq(account.userId, existingUser.id),
    columns: { providerId: true, password: true },
  });
  if (identities.some((identity) => identity.providerId === "credential" && identity.password)) {
    return context.json({ flow: "sign-in" });
  }
  return context.json({
    flow: "set-password",
    hasGoogle: identities.some((identity) => identity.providerId === "google"),
  });
}

export async function requestRegistrationOtp(
  context: Context<AppEnvironment>,
  auth: Auth,
) {
  const body = await parseJson(context);
  const parsed = registrationRequestSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

  const email = normalizeEmail(parsed.data.email);
  const limited = await enforceAuthOtpDeliveryRateLimit(context, email);
  if (limited) return limited;

  const existingUser = await findUserByEmail(context, email);
  if (existingUser?.emailVerified) {
    return context.json({ success: true });
  }

  return auth.handler(
    forwardAuthRequest(context, "/api/auth/email-otp/send-verification-otp", {
      email,
      // Better Auth's sign-in OTP primitive safely creates or promotes a user
      // after proving mailbox ownership. Its public sign-in route stays blocked.
      type: "sign-in",
    }),
  );
}

export async function requestPasswordResetOtp(
  context: Context<AppEnvironment>,
  auth: Auth,
) {
  const body = await parseJson(context);
  const parsed = registrationRequestSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

  const email = normalizeEmail(parsed.data.email);
  const limited = await enforceAuthOtpDeliveryRateLimit(context, email);
  if (limited) return limited;

  return auth.handler(
    forwardAuthRequest(context, "/api/auth/email-otp/request-password-reset", {
      email,
    }),
  );
}

export async function completeRegistration(
  context: Context<AppEnvironment>,
  auth: Auth,
) {
  const body = await parseJson(context);
  const parsed = registrationCompletionSchema.safeParse(body);
  if (!parsed.success) return context.json({ error: "invalid_request" }, 400);

  const email = normalizeEmail(parsed.data.email);
  const existingUser = await findUserByEmail(context, email);
  if (existingUser?.emailVerified) {
    return context.json({ error: "invalid_registration" }, 400);
  }

  const verification = await auth.handler(
    forwardAuthRequest(context, "/api/auth/sign-in/email-otp", {
      email,
      otp: parsed.data.otp,
      name: "Same Page 用户",
    }),
  );
  if (!verification.ok) {
    return context.json({ error: "invalid_registration" }, 400);
  }

  const sessionCookie = cookieFromSetCookie(
    verification.headers.get("set-cookie"),
  );
  if (!sessionCookie) {
    return context.json({ error: "registration_failed" }, 500);
  }

  const sessionHeaders = new Headers({ cookie: sessionCookie });
  try {
    await auth.api.setPassword({
      body: { newPassword: parsed.data.password },
      headers: sessionHeaders,
    });
  } catch {
    await auth.api.signOut({ headers: sessionHeaders }).catch(() => undefined);
    return context.json({ error: "registration_failed" }, 500);
  }

  return verification;
}

async function findUserByEmail(
  context: Context<AppEnvironment>,
  email: string,
) {
  return createDatabase(context.env.DB).query.user.findFirst({
    where: eq(user.email, email),
    columns: { id: true, emailVerified: true },
  });
}

function forwardAuthRequest(
  context: Context<AppEnvironment>,
  pathname: string,
  body: unknown,
) {
  const headers = new Headers(context.req.raw.headers);
  headers.set("content-type", "application/json");
  return new Request(new URL(pathname, context.req.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function parseJson(context: Context<AppEnvironment>) {
  return context.req.raw.clone().json<unknown>().catch(() => null);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function enforceAuthFlowRateLimit(
  context: Context<AppEnvironment>,
  email: string,
) {
  const clientIdentity =
    context.req.header("CF-Connecting-IP") ?? "local-development";
  const ipKey = await hashRateLimitIdentity(
    `auth-flow:ip:${clientIdentity}`,
    context.env.INVITE_SECRET,
  );
  const ipResult = await consumeRateLimit(context.env.DB, ipKey, {
    maxAttempts: 30,
    windowMs: 60_000,
  });
  if (!ipResult.allowed) {
    context.header("Retry-After", String(ipResult.retryAfterSeconds));
    return context.json({ error: "try_again_later" }, 429);
  }

  const emailKey = await hashRateLimitIdentity(
    `auth-flow:email:${email}`,
    context.env.INVITE_SECRET,
  );
  const emailResult = await consumeRateLimit(context.env.DB, emailKey, {
    maxAttempts: 10,
    windowMs: 60_000,
  });
  if (emailResult.allowed) return null;

  context.header("Retry-After", String(emailResult.retryAfterSeconds));
  return context.json({ error: "try_again_later" }, 429);
}

function cookieFromSetCookie(setCookie: string | null) {
  return setCookie?.split(";", 1)[0] ?? null;
}
