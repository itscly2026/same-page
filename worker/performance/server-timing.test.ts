import { describe, expect, it } from "vitest";

import { createRequestServerTiming } from "./server-timing";

describe("Server-Timing", () => {
  it("reports only fixed non-sensitive phase names", async () => {
    let now = 0;
    const timing = createRequestServerTiming({
      now: () => now,
      delayMs: 20,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await timing.measure("auth", async () => {
      now += 5;
    });
    await timing.measure("d1", async () => {
      now += 7;
    });
    now += 3;

    expect(timing.header()).toBe(
      "auth;dur=25.0, d1;dur=27.0, total;dur=55.0",
    );
  });
});
