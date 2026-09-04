import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupRateLimits, consumeRateLimit, RATE_LIMIT_CLEANUP_BATCH_SIZE } from "./rate-limit";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
});
afterEach(() => vi.restoreAllMocks());

describe("bounded rate-limit cleanup", () => {
  it("deletes expired and exactly expired windows, retaining live counters", async () => {
    await env.DB.prepare(
      "INSERT INTO rate_limits VALUES ('expired', 4, 99), ('boundary', 5, 100), ('live', 6, 101)",
    ).run();
    expect(await cleanupRateLimits(env.DB, 100)).toBe(2);
    expect((await env.DB.prepare("SELECT * FROM rate_limits").all()).results).toEqual([
      { key: "live", count: 6, window_expires_at: 101 },
    ]);
    expect(await cleanupRateLimits(env.DB, 100)).toBe(0);
  });

  it("handles empty tables and drains a backlog in bounded oldest-first batches", async () => {
    expect(await cleanupRateLimits(env.DB, 1000)).toBe(0);
    await env.DB.prepare(
      `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < ?)
       INSERT INTO rate_limits SELECT 'fixture-' || n, 1, n FROM sequence`,
    ).bind(RATE_LIMIT_CLEANUP_BATCH_SIZE + 2).run();
    expect(await cleanupRateLimits(env.DB, 1000)).toBe(RATE_LIMIT_CLEANUP_BATCH_SIZE);
    expect((await env.DB.prepare("SELECT window_expires_at FROM rate_limits ORDER BY window_expires_at").all()).results)
      .toEqual([{ window_expires_at: 501 }, { window_expires_at: 502 }]);
    expect(await cleanupRateLimits(env.DB, 1000)).toBe(2);
    expect(await cleanupRateLimits(env.DB, 1000)).toBe(0);
  });

  it("retains a window renewed before the atomic delete executes", async () => {
    await consumeRateLimit(env.DB, "renewed", { maxAttempts: 1, windowMs: 100, now: 0 });
    // There is no separate candidate scan to race: creation of the prepared
    // statement may precede renewal, but selection and deletion run atomically.
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("DELETE FROM rate_limits")) {
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          vi.spyOn(bound, "run").mockImplementation(async () => {
            await consumeRateLimit(env.DB, "renewed", { maxAttempts: 1, windowMs: 100, now: 100 });
            return run();
          });
          return bound;
        });
      }
      return statement;
    });
    expect(await cleanupRateLimits(env.DB, 100)).toBe(0);
    expect(await consumeRateLimit(env.DB, "renewed", { maxAttempts: 1, windowMs: 100, now: 101 }))
      .toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(await env.DB.prepare("SELECT count, window_expires_at FROM rate_limits").first())
      .toEqual({ count: 2, window_expires_at: 200 });
  });

  it("preserves new-window limiting when deletion happens before renewal", async () => {
    await consumeRateLimit(env.DB, "removed", { maxAttempts: 1, windowMs: 100, now: 0 });
    expect(await cleanupRateLimits(env.DB, 100)).toBe(1);
    expect(await consumeRateLimit(env.DB, "removed", { maxAttempts: 1, windowMs: 100, now: 100 }))
      .toEqual({ allowed: true, retryAfterSeconds: 1 });
    expect(await consumeRateLimit(env.DB, "removed", { maxAttempts: 1, windowMs: 100, now: 101 }))
      .toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("logs counts only and tolerates a failed log sink", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await env.DB.prepare("INSERT INTO rate_limits VALUES ('private-identity', 1, 0)").run();
    expect(await cleanupRateLimits(env.DB, 1)).toBe(1);
    expect(log).toHaveBeenCalledWith('{"event":"same_page_rate_limit_cleanup","removed":1}');
    log.mockImplementation(() => { throw new Error("sink unavailable"); });
    expect(await cleanupRateLimits(env.DB, 1)).toBe(0);
  });
});
