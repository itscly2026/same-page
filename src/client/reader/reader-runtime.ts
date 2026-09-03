import { lazy } from "react";

let readerPageModule: ReturnType<typeof importReaderPage> | null = null;

function importReaderPage() {
  return import("../routes/reader-page");
}

export function loadReaderPage() {
  readerPageModule ??= importReaderPage();
  return readerPageModule;
}

export const ReaderPage = lazy(loadReaderPage);

export async function prepareReaderRuntime() {
  const [, pdf] = await Promise.all([
    loadReaderPage(),
    import("./pdf-document"),
  ]);
  pdf.preloadPdfWorkerAsset();
  document.documentElement.dataset.readerRuntime = "ready";
}

export function scheduleReaderRuntimePreload(
  prepare: () => Promise<unknown> = prepareReaderRuntime,
) {
  let cancelled = false;
  const run = () => {
    if (!cancelled) void prepare().catch(() => undefined);
  };
  if ("requestIdleCallback" in window) {
    const idleId = window.requestIdleCallback(run, { timeout: 2_000 });
    return () => {
      cancelled = true;
      window.cancelIdleCallback(idleId);
    };
  }
  const timer = globalThis.setTimeout(run, 600);
  return () => {
    cancelled = true;
    globalThis.clearTimeout(timer);
  };
}
