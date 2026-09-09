import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

// Only synthetic fixtures may use this recorder. Start after authentication.
// No DOM snapshots, network bodies/headers, source files or screencast frames:
// the action trace plus a masked failure screenshot is sufficient for these flows.
export async function withBrowserEvidence(context, directory, run) {
  const errors = [];
  const listeners = new Map();
  const observe = page => {
    const listener = error => errors.push({
      name: error.name,
      // Keep source locations, never arbitrary exception text (which may echo user input).
      locations: [...(error.stack ?? "").matchAll(/https?:\/\/[^\s)]+/g)].map(([value]) => {
        const url = new URL(value); return `${url.origin}${url.pathname}`;
      }),
    });
    listeners.set(page, listener);
    page.on("pageerror", listener);
  };
  context.pages().forEach(observe);
  context.on("page", observe);
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  try {
    return await run();
  } catch (error) {
    await mkdir(directory, { recursive: true });
    const pages = context.pages().filter(page => !page.isClosed());
    await writeFile(`${directory}/failure.json`, JSON.stringify({
      // Strip queries/fragments (which can contain credentials), never dump DOM text.
      urls: pages.map(page => { const url = new URL(page.url()); return `${url.origin}${url.pathname}`; }),
      pageErrors: errors,
    }, null, 2));
    for (const [index, page] of pages.entries()) {
      await page.screenshot({ path: `${directory}/page-${index}.png`, mask: [page.locator("input, textarea, [contenteditable], .annotation-overlay")] }).catch(() => {});
    }
    const temporary = await mkdtemp(path.join(tmpdir(), "same-page-trace-"));
    try {
      const raw = path.join(temporary, "raw.zip");
      await context.tracing.stop({ path: raw });
      execFileSync("python3", [fileURLToPath(new URL("./sanitize-browser-trace.py", import.meta.url)), raw, `${directory}/trace.zip`]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    throw error;
  } finally {
    context.off("page", observe);
    for (const [page, listener] of listeners) page.off("pageerror", listener);
    await context.tracing.stop().catch(() => {});
  }
}
