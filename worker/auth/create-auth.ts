import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins";

import { createDatabase } from "../db/database";
import { schema } from "../db/schema";
import { sendSignInOtp } from "../email/send-otp";
import type { Env, WaitUntilContext } from "../env";
import { hashRateLimitIdentity } from "../security/join-code";
import { consumeRateLimit } from "../security/rate-limit";

export function createAuth(env: Env, executionContext: WaitUntilContext) {
  const database = createDatabase(env.DB);

  return betterAuth({
    appName: "Same Page",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.BETTER_AUTH_URL],
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: false,
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
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") {
            throw new Error("Unsupported OTP type");
          }

          executionContext.waitUntil(sendSignInOtp(env, email, otp));
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
