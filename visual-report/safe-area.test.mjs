import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

// Synthetic insets verify our layout contract, not iPadOS inset reporting.
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: ordinary routes and portals respect safe areas`, async t => {
    const server = await startVisualServer({ script: "dev" });
    t.after(() => server.stop());
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 834, height: 1000 }, serviceWorkers: "block" });
    await page.route("**/api/**", route => route.fulfill(resolveFixtureRequest({ pathname: new URL(route.request().url()).pathname, method: route.request().method(), identity: "guest", cookie: "" })));
    await page.goto(`${server.origin}/#home`);
    await page.locator('.app-header').waitFor();
    const initial = await page.locator('.app-header').boundingBox();
    assert.equal(initial.y, 0, 'zero inset keeps original header origin');
    await page.evaluate(() => {
      for (const [edge, value] of Object.entries({ top: 32, bottom: 24, left: 18, right: 18 })) document.documentElement.style.setProperty(`--safe-${edge}`, `${value}px`);
    });
    const header = await page.locator('.app-header').boundingBox();
    assert.equal(header.y, 32, 'home header must start below status bar');
    assert.equal(header.height, initial.height, 'inset belongs to shell, not header twice');
    for (const route of ['/about', '/privacy', '/choirs/visual-choir']) {
      await page.goto(`${server.origin}${route}`);
      await page.locator('.page-with-footer').waitFor();
      await page.evaluate(() => {
        for (const [edge, value] of Object.entries({ top: 32, bottom: 24, left: 18, right: 18 })) document.documentElement.style.setProperty(`--safe-${edge}`, `${value}px`);
      });
      const control = page.locator(route.includes('choirs') ? '.drive-header' : '.task-header');
      await control.waitFor();
      const box = await control.boundingBox();
      assert.ok(box.y >= 32 && box.x >= 18 && box.x + box.width <= 816, `${route}: header inside safe bounds`);
      if (route.includes('choirs')) {
        await page.evaluate(() => window.scrollTo(0, 400));
        assert.ok((await control.boundingBox()).y >= 32, 'sticky header respects status area after scrolling');
      }
    }
    // Exercise shared portal CSS with overflowing content, independent of permissions.
    await page.evaluate(() => {
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      overlay.innerHTML = '<div class="app-modal"><div class="app-dialog"><button>Safe action</button><div style="height:2000px"></div><button>Last action</button></div></div>';
      document.body.append(overlay);
    });
    for (const width of [834, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const box = await page.locator('.app-dialog').boundingBox();
      assert.ok(box.y >= 32 && box.y + box.height <= 976, 'dialog fits safe vertical area');
      assert.ok(box.x >= 18 && box.x + box.width <= width - 18, 'dialog fits safe horizontal area');
      await page.getByText('Last action', { exact: true }).scrollIntoViewIfNeeded();
      const last = await page.getByText('Last action', { exact: true }).boundingBox();
      assert.ok(last.y + last.height <= 976, 'last action remains reachable');
    }
    await page.locator('.modal-overlay').evaluate(el => el.remove());
    await page.setViewportSize({ width: 834, height: 1000 });
    await page.goto(`${server.origin}/#home`);
    await page.locator('.app-header').waitFor();
    await page.evaluate(() => document.documentElement.style.setProperty('--safe-top', '32px'));
    await mkdir('artifacts/verification/safe-area', { recursive: true });
    await page.screenshot({ path: `artifacts/verification/safe-area/${name}-home.png` });
  });
}
