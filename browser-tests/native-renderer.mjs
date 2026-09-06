import { spawn } from "node:child_process";
import path from "node:path";
import { detachedProcessGroup, stopChildProcessTree } from "../scripts/process-lifecycle.mjs";

export async function startNativeRenderer() {
  const child = spawn(process.env.SAME_PAGE_RENDERER_PYTHON ?? "python3", [path.resolve("renderer/server.py"), "0"], {
    env: { ...process.env, PDF_RENDERER_SECRET: "same-page-native-renderer-test-secret-only" },
    detached: detachedProcessGroup(), stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () => stopChildProcessTree(child);
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("native_renderer_start_timeout")), 10_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("native_renderer_start_failed")); });
      child.stdout.once("data", data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
    });
    if (!Number.isInteger(port) || port <= 0) throw new Error("native_renderer_invalid_port");
    return { origin: `http://127.0.0.1:${port}`, stop };
  } catch (error) { await stop(); throw error; }
}
