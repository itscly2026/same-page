import process from "node:process";

export function detachedProcessGroup() {
  return process.platform !== "win32";
}

export async function stopChildProcessTree(child, graceMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalChildProcessTree(child, "SIGTERM");
  const exitedGracefully = await Promise.race([
    exited.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (!exitedGracefully) {
    signalChildProcessTree(child, "SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

function signalChildProcessTree(child, signal) {
  if (detachedProcessGroup() && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
