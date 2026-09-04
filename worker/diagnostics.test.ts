import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exports } from "cloudflare:workers";
import { diagnosticMiddleware } from "./diagnostics";
import type { AppEnvironment } from "./env";

afterEach(() => vi.restoreAllMocks());

describe("Worker private diagnostics", () => {
  it("correlates and bounds unexpected failures without serializing exceptions or request data", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const app = new Hono<AppEnvironment>();
    app.use("*", diagnosticMiddleware);
    app.get("*", () => { throw new Error("secret-OTP secret-email secret-annotation"); });
    app.onError(() => Response.json({ error: "internal_error" }, { status: 500 }));
    const response = await app.request("https://same-page.test/api/choirs/secret-score?code=secret-token", { headers: { cookie: "secret-cookie", "X-Same-Page-Request-Id": "secret-header" } });
    const requestId = response.headers.get("X-Same-Page-Request-Id");
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(requestId!);
    expect(log.mock.calls[0][0]).not.toContain("secret");
    for (let index = 0; index < 30; index += 1) await app.request("/api/choirs/private");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("keeps real Worker headers and response bodies safe", async () => {
    const response = await exports.default.fetch(new Request("https://same-page.test/api/unknown?code=secret", { headers: { "X-Same-Page-Request-Id": "secret" } }));
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Same-Page-Request-Id")).toMatch(/^[a-f0-9-]{36}$/);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("returns failures normally even when the log sink throws", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("sink unavailable"); });
    const app = new Hono<AppEnvironment>();
    app.use("*", diagnosticMiddleware);
    app.get("*", (context) => context.json({ error: "forbidden" }, 403));
    expect((await app.request("/api/auth/private")).status).toBe(403);
  });
});
