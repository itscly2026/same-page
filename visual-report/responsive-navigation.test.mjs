import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

import { startViteServer } from "../scripts/vite-server.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let server;
let origin = process.env.LAYOUT_TEST_ORIGIN;

before(async () => {
  if (!origin) {
    server = await startViteServer({ script: "dev", port: 4196, cwd: repositoryRoot });
    origin = server.origin;
  }
});
after(async () => { await server?.stop(); });

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: library uses left-aligned compact search and right-aligned sort`, async (t) => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    for (const identity of ["member", "admin"]) {
      const page = await openPage(browser, identity);
      for (const width of [834, 768, 1024, 1194, 1440, 320, 360, 390, 412]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`${origin}/choirs/visual-choir`, { waitUntil: "domcontentloaded" });
        await page.locator(".file-list").waitFor();
        const toolbar = await page.locator(".library-toolbar").boundingBox();
        const search = await page.getByPlaceholder("搜索乐谱").boundingBox();
        const sort = await page.getByRole("combobox", { name: "乐谱排序" }).boundingBox();
        assert.ok(Math.abs(search.x - toolbar.x - 16) < 2, `${width}: search belongs at toolbar left`);
        assert.ok(Math.abs(sort.x + sort.width - toolbar.x - toolbar.width + 16) < 2, `${width}: sort belongs at toolbar right`);
        if (width >= 768) {
          assert.ok(Math.abs(search.y + search.height / 2 - sort.y - sort.height / 2) < 2, `${width}: search and sort must share a row`);
          assert.ok(search.width <= 320, `${width}: search should not stretch across the toolbar`);
        }
        assert.ok(search.height >= 44 && sort.height >= 44, "search and sort have touch-sized controls");
        assert.ok(search.y + search.height <= sort.y || search.x + search.width <= sort.x, "controls do not overlap");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await capture(page, `${engineName}-library-${identity}-${width}`);
      }
      await page.getByPlaceholder("搜索乐谱").fill("晨光");
      await page.getByRole("status").filter({ hasText: "找到 1 份" }).waitFor();
      await page.getByRole("combobox", { name: "乐谱排序" }).selectOption("updated");
      assert.equal(await page.locator(".file-row").count(), 1);
      await page.context().close();
    }
  });

  test(`${engineName}: low-frequency help stays discoverable without primary links`, async (t) => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    for (const identity of ["guest", "member"]) {
      const page = await openPage(browser, identity);
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: identity === "guest" ? "Harmony begins on the Same Page" : "我已加入的云盘", exact: true }).waitFor();
      assert.equal(await page.getByRole("link", { name: "故障诊断", exact: true }).count(), 0);
      assert.equal(await page.locator(".marketing-footer").count(), identity === "guest" ? 1 : 0);
      if (identity === "guest") assert.equal(await page.getByRole("link", { name: "隐私政策", exact: true }).getAttribute("href"), "/privacy");
      else assert.equal(await page.getByRole("link", { name: "隐私政策", exact: true }).count(), 0);
      const help = page.getByRole("button", { name: "帮助与关于", exact: true });
      await help.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "帮助与关于", exact: true });
      await menu.waitFor();
      for (const name of ["故障诊断", "隐私政策"]) {
        const item = menu.getByRole("menuitem", { name, exact: true });
        const box = await item.boundingBox();
        assert.ok(box.height >= 44 && box.width >= 44);
      }
      await capture(page, `${engineName}-help-${identity}-320`);
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "帮助与关于", undefined, { timeout: 5000 });
      assert.equal(await help.evaluate(el => el === document.activeElement), true);
      await page.evaluate(() => { window.__layoutDocumentMarker = "same-document"; });
      await help.press("Enter");
      await page.getByRole("menuitem", { name: "隐私政策", exact: true }).click();
      await page.getByRole("heading", { name: "隐私政策", exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/privacy");
      assert.equal(await page.evaluate(() => window.__layoutDocumentMarker), "same-document");
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "帮助与关于", exact: true }).click();
      await page.evaluate(() => { window.__layoutDocumentMarker = "same-document"; });
      await page.getByRole("menuitem", { name: "故障诊断", exact: true }).click();
      await page.getByRole("textbox", { name: "可发送给支持人员的诊断内容" }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/diagnostics");
      assert.equal(await page.evaluate(() => window.__layoutDocumentMarker), "same-document");
      await page.context().close();
    }
  });
}

async function openPage(browser, identity) {
  const context = await browser.newContext({ serviceWorkers: "block", locale: "zh-CN", colorScheme: "light" });
  await context.route("**/api/**", route => route.fulfill(resolveFixtureRequest({
    pathname: new URL(route.request().url()).pathname,
    method: route.request().method(),
    identity,
    cookie: route.request().headers().cookie ?? "",
  })));
  return context.newPage();
}

async function capture(page, name) {
  if (!process.env.LAYOUT_CAPTURE_DIR) return;
  await mkdir(process.env.LAYOUT_CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.LAYOUT_CAPTURE_DIR, `${name}.png`) });
}
