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

it("cleans a descendant even after its launcher exits", async () => {
  if (process.platform === "win32") return;
  const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(p.pid); p.unref();`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
  await new Promise((resolve) => child.once("exit", resolve));
  try {
    await stopChildProcessTree(child, 300);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
});
