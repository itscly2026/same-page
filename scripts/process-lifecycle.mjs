import process from "node:process";

export function detachedProcessGroup() {
  return process.platform !== "win32";
}

export async function stopChildProcessTree(child, graceMs = 3_000) {
  const alive = () => {
    if (!detachedProcessGroup() || !child.pid) return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error?.code === "ESRCH") return false; throw error; }
  };
  try {
    if (!alive()) return;
    signalChildProcessTree(child, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (alive() && Date.now() < deadline) await delay(50);
    if (alive()) {
      signalChildProcessTree(child, "SIGKILL");
      const killDeadline = Date.now() + 1_000;
      while (alive() && Date.now() < killDeadline) await delay(50);
    }
  } finally {
    child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
  }
}

function signalChildProcessTree(child, signal) {
  if (detachedProcessGroup() && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  child.kill(signal);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
