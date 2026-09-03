import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins";

import { PASSWORD_POLICY } from "../../src/shared/auth";
import { createDatabase } from "../db/database";
import { schema } from "../db/schema";
import { sendAuthOtp } from "../email/send-otp";
import type { Env, WaitUntilContext } from "../env";
import {
  consumeRateLimit,
  hashRateLimitIdentity,
} from "../security/rate-limit";
import { createSocialProviderOptions } from "./social-providers";
import {
  AUTH_OTP_CLIENT_MAX,
  AUTH_OTP_WINDOW_SECONDS,
} from "./otp-delivery-rate-limit";

export function createAuth(env: Env, executionContext: WaitUntilContext) {
  const database = createDatabase(env.DB);

  return betterAuth({
    appName: "Same Page",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    disabledPaths: [
      "/account-info",
      "/get-access-token",
      "/link-social",
      "/list-accounts",
      "/refresh-token",
      "/unlink-account",
    ],
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema,
    }),
    account: {
      encryptOAuthTokens: true,
    },
    databaseHooks: {
      account: {
        create: {
          async before(account) {
            return { data: { ...account, idToken: null } };
          },
        },
        update: {
          async before(account) {
            return { data: { ...account, idToken: null } };
          },
        },
      },
    },
    onAPIError: {
      errorURL: "/login?oauth=error",
    },
    socialProviders: createSocialProviderOptions(env),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: PASSWORD_POLICY.minLength,
      maxPasswordLength: PASSWORD_POLICY.maxLength,
      revokeSessionsOnPasswordReset: true,
    },
    logger: {
      disabled: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
      customStorage: {
        async consume(key, rule) {
          const protectedKey = await hashRateLimitIdentity(
            `auth:${key}`,
            env.INVITE_SECRET,
          );
          const result = await consumeRateLimit(env.DB, protectedKey, {
            maxAttempts: rule.max,
            windowMs: rule.window * 1000,
          });
          return {
            allowed: result.allowed,
            retryAfter: result.allowed ? null : result.retryAfterSeconds,
          };
        },
      },
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    plugins: [
      emailOTP({
        expiresIn: 600,
        allowedAttempts: 3,
        rateLimit: {
          window: AUTH_OTP_WINDOW_SECONDS,
          max: AUTH_OTP_CLIENT_MAX,
        },
        storeOTP: "hashed",
        disableSignUp: false,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in" && type !== "forget-password") {
            throw new Error("Unsupported OTP type");
          }

          executionContext.waitUntil(
            sendAuthOtp(
              env,
              email,
              otp,
              type === "sign-in" ? "registration" : type,
            ),
          );
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
