export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
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
