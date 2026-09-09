// JSDOM does not implement Web Locks. Browser tests exercise the real API;
// preference integration tests use this public per-name lock contract.
export function installReadingPreferenceLocks() {
  const locks = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request(name: string, options: { signal?: AbortSignal; ifAvailable?: boolean }, action: (lock: { name: string; mode: string } | null) => Promise<unknown>) {
      if (options.ifAvailable && locks.has(name)) return action(null);
      const previous = locks.get(name) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => { options.signal?.throwIfAborted(); return action({ name, mode: "exclusive" }); });
      locks.set(name, task);
      return task.finally(() => { if (locks.get(name) === task) locks.delete(name); });
    },
  } });
}
