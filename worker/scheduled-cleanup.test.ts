import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./index";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM rate_limits").run();
});
afterEach(() => vi.restoreAllMocks());

describe("independent scheduled cleanup tasks", () => {
  it("cleans rate limits even when score cleanup fails, with a sanitized failure", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await env.DB.prepare("INSERT INTO rate_limits VALUES ('private-identity', 1, 0)").run();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("SELECT id FROM scores")) throw new Error("private-database-detail");
      return prepare(sql);
    });
    const context = createExecutionContext();
    worker.scheduled(createScheduledController(), env, context);
    await expect(waitOnExecutionContext(context)).rejects.toThrow("score_storage_cleanup_failed");
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM rate_limits").first())
      .toEqual({ count: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("continues score cleanup after rate-limit failure without affecting requests", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const prepare = env.DB.prepare.bind(env.DB);
    const queries: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      queries.push(sql);
      if (sql.startsWith("DELETE FROM rate_limits")) throw new Error("private-database-detail");
      return prepare(sql);
    });
    const context = createExecutionContext();
    worker.scheduled(createScheduledController(), env, context);
    await expect(waitOnExecutionContext(context)).rejects.toThrow("rate_limit_cleanup_failed");
    expect(queries.some((sql) => sql.includes("SELECT id, object_key FROM score_object_deletions"))).toBe(true);
    expect((await worker.fetch(new Request("https://same-page.test/api/health"), env, createExecutionContext())).status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });
});
