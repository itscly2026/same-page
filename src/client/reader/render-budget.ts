const MAX_RESIDENT_PIXELS = 24 * 1024 * 1024;
const allocations = new Map<HTMLCanvasElement, number>();
let running = 0;
const waiters = new Set<() => void>();

export async function acquireRenderSlot(signal: AbortSignal) {
  while (running >= 2) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener("abort", cancel); waiters.delete(wake); resolve(); };
      const cancel = () => { waiters.delete(wake); reject(signal.reason); };
      waiters.add(wake); signal.addEventListener("abort", cancel, { once: true });
    });
  }
  signal.throwIfAborted();
  running++;
  return () => { running--; [...waiters].forEach(wake => wake()); };
}
export function sizeRenderCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const occupied = [...allocations].reduce((sum, [key, pixels]) => sum + (key === canvas ? 0 : pixels), 0);
  const budget = Math.min(4 * 1024 * 1024, MAX_RESIDENT_PIXELS - occupied);
  if (budget < 64 * 1024) throw new Error("canvas_memory_budget");
  const scale = Math.min(1, 4096 / Math.max(width, height), Math.sqrt(budget / (width * height)));
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  allocations.set(canvas, canvas.width * canvas.height);
}
export function releaseRenderCanvas(canvas: HTMLCanvasElement) {
  allocations.delete(canvas); canvas.width = 1; canvas.height = 1;
}
