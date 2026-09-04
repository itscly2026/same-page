import { encodeBase64Url, signHmac } from "./crypto";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export const RATE_LIMIT_CLEANUP_BATCH_SIZE = 500;

/** One atomic statement: a renewed window cannot be deleted from a stale scan. */
export async function cleanupRateLimits(
  binding: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await binding.prepare(
    `DELETE FROM rate_limits
     WHERE window_expires_at <= ? AND key IN (
       SELECT key FROM rate_limits
       WHERE window_expires_at <= ?
       ORDER BY window_expires_at, key
       LIMIT ?
     )`,
  ).bind(now, now, RATE_LIMIT_CLEANUP_BATCH_SIZE).run();
  const removed = result.meta.changes;
  try {
    console.info(JSON.stringify({ event: "same_page_rate_limit_cleanup", removed }));
  } catch { /* Logging must not change the cleanup result. */ }
  return removed;
}

export async function hashRateLimitIdentity(
  identity: string,
  secret: string,
): Promise<string> {
  return encodeBase64Url(
    await signHmac(secret, "invite-rate-limit", identity),
  );
}

export async function consumeRateLimit(
  binding: D1Database,
  key: string,
  options: {
    maxAttempts: number;
    windowMs: number;
    now?: number;
  },
): Promise<RateLimitResult> {
  const now = options.now ?? Date.now();
  const nextExpiry = now + options.windowMs;

  const row = await binding
    .prepare(
      `INSERT INTO rate_limits (key, count, window_expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.window_expires_at <= ? THEN 1
           ELSE rate_limits.count + 1
         END,
         window_expires_at = CASE
           WHEN rate_limits.window_expires_at <= ? THEN excluded.window_expires_at
           ELSE rate_limits.window_expires_at
         END
       RETURNING count, window_expires_at`,
    )
    .bind(key, nextExpiry, now, now)
    .first<{ count: number; window_expires_at: number }>();

  if (!row) {
    throw new Error("Rate limit state was not returned");
  }

  return {
    allowed: row.count <= options.maxAttempts,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((row.window_expires_at - now) / 1000),
    ),
  };
}
