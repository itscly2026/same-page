import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";
let server;
before(async () => { server = await startVisualServer({ script: "dev" }); });
after(async () => { await server?.stop(); });
async function open(context, engine) {
  const browser = await engine.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1194, height: 700 }, hasTouch: true, serviceWorkers: "block" });
  await page.route("**/api/**", route => route.fulfill(resolveFixtureRequest({ pathname: new URL(route.request().url()).pathname, method: route.request().method(), identity: "guest", scenarioId: "reader-controls-narrow", cookie: route.request().headers().cookie ?? "" })));
  await page.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
  await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`);
  await page.locator('.page-reader__sheet[data-page-turn-current] canvas[data-pdf-canvas-active]').waitFor();
  await page.locator('.page-reader__viewport').click({ position: { x: 590, y: 350 } });
  await page.getByRole('button', { name: '更多', exact: true }).click();
  return page;
}

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: tool switching retains ink nodes and restores tool after reload`, async context => {
    const page = await open(context, engine);
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('button', { name: '文字', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '荧光笔', exact: true }).click();
    const overlay = page.getByLabel('第 1 页笔记层');
    const box = await overlay.boundingBox();
    await page.mouse.move(box.x + box.width * .2, box.y + box.height * .4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .4, { steps: 20 });
    await page.mouse.move(box.x + box.width * .3, box.y + box.height * .4, { steps: 20 });
    await page.mouse.up();
    await expect(overlay.locator('[data-ink-stroke]')).toHaveCount(2);
    // Wait for the final released stroke, not an earlier durable checkpoint.
    await expect.poll(() => overlay.locator('[data-ink-stroke]').nth(1).evaluate(path => path.getBBox().x / 1000)).toBeLessThan(.31);
    await overlay.evaluate(el => { window.savedOverlay = el; window.savedInk = [...el.querySelectorAll('[data-ink-stroke]')]; window.savedPaths = window.savedInk.map(path => path.getAttribute('d')); });
    for (const tool of ['整条橡皮', '选择', '文字', '荧光笔']) {
      await page.getByRole('button', { name: tool, exact: true }).click();
      assert.equal(await overlay.evaluate(el => el === window.savedOverlay && [...el.querySelectorAll('[data-ink-stroke]')].every((path, i) => path === window.savedInk[i])), true, `${tool}: retains nodes`);
      assert.deepEqual(await overlay.locator('[data-ink-stroke]').evaluateAll(paths => paths.map(path => path.getAttribute('d'))), await page.evaluate(() => window.savedPaths), `${tool}: retains geometry`);
    }
    await page.getByRole('button', { name: '完成编辑', exact: true }).click();
    await page.getByRole('button', { name: '更多', exact: true }).click();
    const paths = () => page.locator('[data-ink-stroke]').evaluateAll(elements => elements.map(el => el.getAttribute('d')));
    const original = await paths();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await page.locator('canvas[data-pdf-canvas-active]').first().waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const enlarged = await paths();
    assert.deepEqual(enlarged, original, "zoom must preserve normalized ink geometry");
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await paths(), original, "zooming back must preserve normalized ink geometry");
    await page.reload();
    await page.locator('canvas[data-pdf-canvas-active]').first().waitFor();
    await expect(page.locator('.annotation-controls')).toHaveCount(0);
    await page.locator('.page-reader__viewport').click({ position: { x: 590, y: 350 } });
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('button', { name: '荧光笔', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('第 1 页笔记层').locator('[data-ink-stroke]')).toHaveCount(2);
  });
}
