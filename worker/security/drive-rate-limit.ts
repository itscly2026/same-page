import type { Context } from "hono";
import type { AppEnvironment } from "../env";
import { consumeRateLimit, hashRateLimitIdentity } from "./rate-limit";

export async function limitDriveMutation(context: Context<AppEnvironment>, userId: string, operation: string, maxAttempts: number, windowMs = 60_000) {
  const identity = await hashRateLimitIdentity(`${operation}:${userId}`, context.env.INVITE_SECRET);
  const result = await consumeRateLimit(context.env.DB, identity, { maxAttempts, windowMs });
  if (result.allowed) return null;
  context.header("Retry-After", String(result.retryAfterSeconds));
  return context.json({ error: "try_again_later" }, 429);
}
