import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { detachedProcessGroup, stopChildProcessTree } from "./process-lifecycle.mjs";

const running = new Set();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void Promise.all([...running].map((stop) => stop())).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

export async function startViteServer({ script, port, cwd = process.cwd(), env = process.env, timeoutMs = 30_000, prepare }) {
  const statePath = await mkdtemp(path.join(tmpdir(), "same-page-vite-"));
  const logs = [];
  let child;
  let stopping;
  let preparing;
  const shutdown = new AbortController();
  const stop = () => stopping ??= (async () => {
    shutdown.abort();
    try {
      await preparing?.catch(() => undefined);
      if (child) await stopChildProcessTree(child);
    }
    finally { await rm(statePath, { recursive: true, force: true }); running.delete(stop); }
  })();
  running.add(stop);
  try {
    preparing = (async () => {
      port ??= await availablePort();
      const origin = `http://127.0.0.1:${port}`;
      const runId = randomUUID();
      const sourceConfig = script === "preview" ? path.join(cwd, "dist/same_page/wrangler.json") : path.join(cwd, "wrangler.jsonc");
      const config = JSON.parse(await readFile(sourceConfig, "utf8"));
      const configPath = path.join(statePath, "wrangler.json");
      if (config.main) config.main = path.resolve(path.dirname(sourceConfig), config.main);
      if (config.assets?.directory) config.assets.directory = path.resolve(path.dirname(sourceConfig), config.assets.directory);
      delete config.configPath; delete config.userConfigPath;
      for (const db of config.d1_databases ?? []) db.migrations_dir = path.resolve(path.dirname(sourceConfig), db.migrations_dir ?? "migrations");
      config.vars = { ...config.vars, BETTER_AUTH_URL: origin, AUTH_EMAIL_FROM: "Fixture <fixture@example.invalid>", BETTER_AUTH_SECRET: "same-page-local-test-secret-only", INVITE_SECRET: "same-page-local-test-invite-only" };
      config.routes = []; config.triggers = {}; config.observability = { enabled: false };
      await writeFile(configPath, JSON.stringify(config));
      await writeFile(path.join(statePath, ".dev.vars"), "");
      if (script === "preview") {
        await mkdir(path.join(statePath, ".wrangler/deploy"), { recursive: true });
        await writeFile(path.join(statePath, ".wrangler/deploy/config.json"), JSON.stringify({ configPath, auxiliaryWorkers: [] }));
      }
      shutdown.signal.throwIfAborted();
      await prepare?.({ statePath, configPath, origin, signal: shutdown.signal });
      shutdown.signal.throwIfAborted();
      return { origin, runId, configPath };
    })();
    const { origin, runId, configPath } = await preparing;
    shutdown.signal.throwIfAborted();
    const executable = process.platform === "win32" ? "npm.cmd" : "npm";
    child = spawn(executable, ["run", script, "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd, detached: detachedProcessGroup(),
      env: { ...env, SAME_PAGE_TEST_STATE: statePath, SAME_PAGE_TEST_RUN: runId, CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => rememberLog(logs, chunk));
    child.stderr.on("data", (chunk) => rememberLog(logs, chunk));
    const controller = new AbortController();
    const failed = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Vite exited: ${code ?? signal}`)));
    });
    try {
      await Promise.race([waitForServer(origin, runId, timeoutMs, AbortSignal.any([controller.signal, shutdown.signal])), failed]);
    } finally { controller.abort(); }
    return { origin, logs, stop };
  } catch (error) {
    await stop();
    throw new Error(`Vite ${script} failed:\n${logs.join("")}`, { cause: error });
  }
}

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForServer(origin, runId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) });
      if (response.ok && response.headers.get("x-same-page-test-server") === runId) return;
      lastError = new Error(`Unexpected server response: ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite server did not respond at ${origin}`, { cause: lastError });
}

function rememberLog(logs, chunk) {
  logs.push(String(chunk));
  if (logs.length > 40) logs.splice(10, 1);
}
