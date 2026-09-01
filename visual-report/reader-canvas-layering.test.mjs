import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { webkit } from "playwright";

test("a released hidden PDF canvas cannot cover the active canvas", async (context) => {
  const styles = await readFile(
    new URL("../src/client/styles.css", import.meta.url),
    "utf8",
  );
  const browser = await webkit.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });

  await page.setContent(`
    <style>${styles}</style>
    <div class="pdf-page-canvas" style="width: 300px; height: 300px">
      <canvas id="active"></canvas>
      <canvas id="released" hidden></canvas>
    </div>
  `);

  const result = await page.evaluate(() => {
    const active = document.querySelector("#active");
    const released = document.querySelector("#released");
    if (!(active instanceof HTMLCanvasElement)) throw new Error("missing active canvas");
    if (!(released instanceof HTMLCanvasElement)) throw new Error("missing released canvas");

    active.width = 300;
    active.height = 300;
    released.width = 1;
    released.height = 1;

    return {
      releasedDisplay: getComputedStyle(released).display,
      topElementAtPageCenter: document.elementFromPoint(150, 150)?.id,
    };
  });

  assert.deepEqual(result, {
    releasedDisplay: "none",
    topElementAtPageCenter: "active",
  });
});
