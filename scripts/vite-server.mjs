import { spawn } from "node:child_process";
import process from "node:process";

import {
  detachedProcessGroup,
  stopChildProcessTree,
} from "./process-lifecycle.mjs";

export async function startViteServer({
  script,
  port,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 30_000,
}) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(
    executable,
    ["run", script, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd,
      detached: detachedProcessGroup(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => rememberLog(logs, chunk));
  child.stderr.on("data", (chunk) => rememberLog(logs, chunk));

  try {
    await waitForServer(origin, timeoutMs);
  } catch (error) {
    await stopChildProcessTree(child);
    throw new Error(
      `Vite ${script} server did not start at ${origin}:\n${logs.join("")}`,
      { cause: error },
    );
  }

  return {
    logs,
    origin,
    stop: () => stopChildProcessTree(child),
  };
}

async function waitForServer(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
      lastError = new Error(`Vite server responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite server did not respond at ${origin}`, { cause: lastError });
}

function rememberLog(logs, chunk) {
  logs.push(String(chunk));
  if (logs.length > 40) logs.shift();
}
