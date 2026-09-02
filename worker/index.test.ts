import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "../src/shared/health";

describe("Same Page Worker", () => {
  it("serves the same-origin health contract", async () => {
    const response = await exports.default.fetch(
      new Request("https://same-page.test/api/health"),
    );

    expect(response.status).toBe(200);
    const payload = healthResponseSchema.parse(await response.json());
    expect(payload).toEqual({
      status: "ok",
      service: "same-page",
      runtime: "cloudflare-worker",
      buildId: expect.any(String),
    });
    expect(payload.buildId.length).toBeGreaterThan(0);
  });

  it("keeps unknown API routes inside the JSON API boundary", async () => {
    const response = await exports.default.fetch(
      new Request("https://same-page.test/api/missing"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
