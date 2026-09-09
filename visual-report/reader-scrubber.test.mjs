import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { createSampleScorePdf, resolveFixtureRequest } from './fixtures.mjs';
import { startVisualServer } from './setup.mjs';
const source = await PDFDocument.load(createSampleScorePdf());
const document = await PDFDocument.create();
for (let index = 0; index < 30; index++) document.addPage((await document.copyPages(source, [index % 2]))[0]);
const pdf = Buffer.from(await document.save());
const selectedScore = { id: 'visual-score', choirId: 'visual-choir', fileName: 'Thirty pages.pdf', updatedAt: 1,
  currentVersion: { id: 'visual-version-1', versionNumber: 1, sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), etag: 'thirty-pages', pageCount: 30, createdAt: 1 } };

test('whole-score scrubber selects all 30 pages without horizontal scrolling', async t => {
  const app = await startVisualServer({ script: 'dev' });
  t.after(() => app.stop());
  for (const [name, engine] of Object.entries({ chromium, webkit })) await t.test(name, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      await page.route('**/api/**', route => route.fulfill(resolveFixtureRequest({
        pathname: new URL(route.request().url()).pathname, method: route.request().method(),
        identity: 'member', scenarioId: 'reader-scrubber', pdf, selectedScore,
      })));
      await page.addInitScript(() => localStorage.setItem('reader-gesture-hint-seen', 'true'));
      await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
      await page.locator('.reader-loading').waitFor({ state: 'hidden' });
      await page.locator('.page-reader__viewport').click();
      const slider = page.getByRole('slider', { name: '跳转页码' });
      const bounds = await slider.boundingBox();
      assert.ok(bounds);
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(bounds.x + 2, y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 2, y, { steps: 8 });
      assert.equal(await slider.inputValue(), '30');
      assert.equal((await page.getByLabel('页面位置').textContent()).trim(), '30 / 30');
      await page.mouse.up();
      await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="30"]').waitFor();
      assert.equal(await page.locator('.page-preview-strip').evaluate(el => el.scrollWidth > el.clientWidth), false);
      await slider.press('Home');
      await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="1"]').waitFor();
      await slider.press('ArrowRight');
      await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="2"]').waitFor();
      assert.equal(await slider.inputValue(), '2');
      // Cancelling a drag commits the displayed destination and dismisses its preview.
      await page.mouse.move(bounds.x + 8 + (bounds.width - 16) * 14 / 29, y);
      await page.mouse.down();
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
      await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="15"]').waitFor();
      assert.equal(await page.locator('.page-preview-strip__thumbnail[data-active]').count(), 1);
      assert.ok(await page.locator('.page-preview-strip__thumbnail').count() < 30);
      assert.equal(await page.locator('.page-preview-strip__thumbnail[data-active]').evaluate(el => getComputedStyle(el).borderWidth), '0px');
      assert.equal(await page.locator('.page-preview-strip__track').evaluate(el => {
        const boxes = [...el.querySelectorAll('.page-preview-strip__thumbnail:not([data-active])')].map(node => node.getBoundingClientRect());
        return boxes.every((box, index) => index === 0 || box.left >= boxes[index - 1].right);
      }), true);
      await page.mouse.up();
    } finally { await browser.close(); }
  });
});
