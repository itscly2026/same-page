import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

// Synthetic pages: no production PDF, filenames, identities or annotations.
const source = await PDFDocument.create();
const font = await source.embedFont(StandardFonts.Helvetica);
for (let page = 1; page <= 11; page++) {
  source.addPage([600, page === 11 ? 600 : 900]).drawText(`Page ${page}`, { x: 40, y: page === 11 ? 500 : 700, font });
}
const pdf = Buffer.from(await source.save());
const selectedScore = {
  id: "visual-score", choirId: "visual-choir", fileName: "Reader restoration.pdf", updatedAt: 1,
  currentVersion: { id: "visual-version-1", versionNumber: 1, sizeBytes: pdf.length,
    sha256: createHash("sha256").update(pdf).digest("hex"), etag: "restoration-fixture", pageCount: 11, createdAt: 1 },
};

test("restores a later continuous page and confirms its first canvas", { timeout: 60000 }, async t => {
  const app = await startVisualServer({ script: "dev" });
  t.after(() => app.stop());
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    await t.test(name, async () => {
      const browser = await engine.launch();
      try {
        for (const savedPage of [8, 11]) {
          const context = await browser.newContext({ viewport: { width: 820, height: 1148 }, serviceWorkers: "block" });
          try {
            await context.addInitScript(page => {
              localStorage.setItem("reader-gesture-hint-seen", "true");
              const key = "reader-preferences:visual-user-member:visual-choir:visual-score";
              if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ layout: "continuous", page }));
            }, savedPage);
            await context.route("**/api/**", route => route.fulfill(resolveFixtureRequest({
              pathname: new URL(route.request().url()).pathname, method: route.request().method(),
              identity: "member", scenarioId: "reader-presentation", pdf, selectedScore,
            })));
            const page = await context.newPage();
            await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
            let expectedPage = savedPage;
            for (const reopen of [false, true]) {
              if (reopen) await page.reload();
              await page.locator(".continuous-reader").waitFor();
              await page.locator(`.pdf-page-canvas[data-page-number="${expectedPage}"] [data-pdf-canvas-active]`).waitFor({ timeout: 5000 });
              await page.locator(".reader-loading").waitFor({ state: "hidden", timeout: 5000 });
              // Geometry and scroll events commit independently of the first bitmap.
              try {
                await page.waitForFunction(expected => {
                const viewport = document.querySelector(".continuous-reader");
                const threshold = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
                const first = [...viewport.querySelectorAll(".pdf-page-canvas")]
                  .find(canvas => canvas.getBoundingClientRect().bottom + 8 > threshold);
                const selected = JSON.parse(localStorage.getItem("reader-preferences:visual-user-member:visual-choir:visual-score")).page;
                const requested = viewport.querySelector(`.pdf-page-canvas[data-page-number="${expected}"]`);
                const rect = requested?.getBoundingClientRect();
                return selected === Number(first?.dataset.pageNumber) && rect && rect.top < viewport.getBoundingClientRect().bottom && rect.bottom > viewport.getBoundingClientRect().top;
                }, expectedPage, { timeout: 5000 });
              } catch (error) {
                console.error("reader-presentation geometry", JSON.stringify({ engine: name, savedPage, expectedPage, reopen,
                  geometry: await page.locator(".continuous-reader").evaluate(viewport => ({
                    selected: JSON.parse(localStorage.getItem("reader-preferences:visual-user-member:visual-choir:visual-score")).page,
                    scrollTop: viewport.scrollTop, top: viewport.getBoundingClientRect().top,
                    pages: [...viewport.querySelectorAll(".pdf-page-canvas")].map(canvas => ({ page: canvas.dataset.pageNumber,
                      top: canvas.getBoundingClientRect().top, bottom: canvas.getBoundingClientRect().bottom,
                      rowTop: canvas.closest(".continuous-reader__page").getBoundingClientRect().top,
                      rowBottom: canvas.closest(".continuous-reader__page").getBoundingClientRect().bottom })),
                  })),
                })); throw error;
              }
              const actualPage = await page.evaluate(() => JSON.parse(localStorage.getItem("reader-preferences:visual-user-member:visual-choir:visual-score")).page);
              await page.locator(`.pdf-page-canvas[data-page-number="${actualPage}"] [data-pdf-canvas-active]`).waitFor({ timeout: 5000 });
              // Lifecycle simulation is browser integration coverage, not iPad suspension proof.
              const bitmap = page.locator(`.pdf-page-canvas[data-page-number="${actualPage}"] [data-pdf-canvas-active]`);
              const originalPixels = await bitmap.evaluate(canvas => canvas.toDataURL());
              await page.evaluate(() => {
                Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
                document.dispatchEvent(new Event("visibilitychange"));
              });
              await page.evaluate(() => {
                Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
                document.dispatchEvent(new Event("visibilitychange"));
                window.dispatchEvent(new Event("pageshow"));
              });
              assert.equal(await bitmap.evaluate(canvas => canvas.toDataURL()), originalPixels);
              await bitmap.evaluate(canvas => {
                canvas.dispatchEvent(new Event("contextlost"));
                canvas.dispatchEvent(new Event("contextrestored"));
              });
              await bitmap.waitFor();
              await page.waitForFunction(({ number, pixels }) => {
                const canvas = document.querySelector(`.pdf-page-canvas[data-page-number="${number}"] [data-pdf-canvas-active]`);
                return canvas?.toDataURL() === pixels;
              }, { number: actualPage, pixels: originalPixels });
              const current = await page.locator(`.pdf-page-canvas[data-page-number="${expectedPage}"]`).boundingBox();
              assert.ok(current.y < 1148 && current.y + current.height > 0, `the requested page must be in the viewport: ${JSON.stringify({ name, savedPage, expectedPage, actualPage, reopen, current, scrollTop: await page.locator(".continuous-reader").evaluate(el => el.scrollTop) })}`);
              expectedPage = actualPage;
            }
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    });
  }
});
