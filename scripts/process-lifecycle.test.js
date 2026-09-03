import { spawn } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  detachedProcessGroup,
  stopChildProcessTree,
} from "./process-lifecycle.mjs";

describe("child process lifecycle", () => {
  it("waits for an isolated long-running process to exit", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { detached: detachedProcessGroup(), stdio: "ignore" },
    );

    await stopChildProcessTree(child);

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
