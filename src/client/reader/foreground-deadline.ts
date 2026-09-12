// A display deadline measures visible time. Background suspension is not a
// rendering failure; browsers may resume timers before animation callbacks.
export function foregroundDeadline(expire: () => void, duration: number) {
  let remaining = duration;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const update = () => {
    if (disposed) return;
    if (document.visibilityState === "hidden") {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        remaining = Math.max(0, remaining - (performance.now() - started));
      }
    } else if (timer === null) {
      started = performance.now();
      timer = setTimeout(() => {
        // Defend against a timer queued just before the visibility event.
        if (document.visibilityState === "hidden") { update(); return; }
        dispose();
        expire();
      }, remaining);
    }
  };
  const dispose = () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    document.removeEventListener("visibilitychange", update);
    window.removeEventListener("pageshow", update);
  };
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pageshow", update);
  update();
  return dispose;
}

export function waitForForeground(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (document.visibilityState !== "hidden") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
      signal.removeEventListener("abort", cancel);
    };
    const update = () => {
      if (document.visibilityState === "hidden") return;
      cleanup();
      resolve();
    };
    const cancel = () => { cleanup(); reject(signal.reason); };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
