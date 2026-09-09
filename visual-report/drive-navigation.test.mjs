import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";
import { withBrowserEvidence } from "../browser-tests/browser-evidence.mjs";

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: mobile drive navigation`, async t => {
    const app = await startVisualServer({ script: "dev" });
    t.after(() => app.stop());
    const browser = await engine.launch();
    t.after(() => browser.close());
    async function scenario(label, run) {
      await t.test(label, async () => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
        try {
          await withBrowserEvidence(context, `artifacts/verification/drive-navigation/${name}-${label}`, async () => {
            const page = await context.newPage();
            const fixture = createVisualFixtureSession();
            await page.route("**/api/**", route => {
              const request = route.request();
              const pathname = new URL(request.url()).pathname;
              const result = fixture.resolve({ pathname, method: request.method(), identity: "admin", cookie: "" });
              if (pathname.endsWith("/bootstrap")) {
                const data = JSON.parse(result.body);
                data.scores = Array.from({ length: 50 }, (_, i) => ({ ...data.scores[0], id: `score-${i}`, fileName: `排练乐谱 ${i + 1}.pdf` }));
                result.body = JSON.stringify(data);
              }
              return route.fulfill(result);
            });
            await run(page);
          });
        } finally { await context.close(); }
      });
    }
    await scenario("history-and-destinations", async page => {
      await page.goto("data:text/html,<h1>Previous document</h1>");
      await page.goto(`${app.origin}/choirs/visual-choir`);
      await page.getByRole("button", { name: "我的" }).waitFor();
      await page.getByRole("button", { name: "打开云盘菜单" }).click();
      await page.getByRole("dialog", { name: "云盘菜单" }).waitFor();
      await page.evaluate(() => history.back());
      await expect(page.getByRole("dialog", { name: "云盘菜单" })).toBeHidden();
      assert.equal(new URL(page.url()).pathname, "/choirs/visual-choir");
      await page.evaluate(() => history.back());
      await page.getByRole("heading", { name: "Previous document" }).waitFor();
      await page.goto(`${app.origin}/choirs/visual-choir`);
      await page.getByRole("button", { name: "我的" }).waitFor();
      await page.getByRole("button", { name: "打开云盘菜单" }).click();
      await page.getByRole("dialog", { name: "云盘菜单" }).waitFor();
      await page.getByRole("link", { name: "云盘列表", exact: true }).click();
      await page.getByRole("heading", { name: "我已加入的云盘" }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/drives");
      await page.getByRole("link", { name: "合谱 Same Page 首页" }).click();
      await page.getByRole("heading", { name: "Harmony begins on the Same Page", exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/");
      await page.getByRole("link", { name: "我的云盘", exact: true }).click();
      await page.getByRole("heading", { name: "我已加入的云盘", exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/drives");
      await page.getByRole("link", { name: /示例云盘/ }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    });
    await scenario("drawer-keyboard-focus", async page => {
      await page.goto(`${app.origin}/choirs/visual-choir`);
      await page.getByRole("button", { name: "打开云盘菜单" }).waitFor();
      await page.getByRole("button", { name: "打开云盘菜单" }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      // React Aria restores focus on the next animation frame after unmount.
      await expect(page.getByRole("dialog", { name: "云盘菜单" })).toBeHidden();
      await expect(page.getByRole("button", { name: "打开云盘菜单" })).toBeFocused();
    });
    await scenario("scroll-upload", async page => {
      await page.goto(`${app.origin}/choirs/visual-choir`);
      const fab = page.getByRole("button", { name: "上传 PDF", exact: true });
      await expect(fab).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 500));
      await expect(fab).toBeHidden();
      // Hidden upload is neither a pointer target nor a keyboard stop.
      await page.locator(".upload-fab").evaluate(button => button.focus());
      await expect(page.locator(".upload-fab")).not.toBeFocused();
      await page.evaluate(() => window.scrollTo(0, 350));
      await expect(fab).toBeVisible();
      await fab.click();
      await expect(page.getByRole("dialog", { name: "上传 PDF", exact: true })).toBeVisible();
    });
    await scenario("focused-upload", async page => {
      await page.goto(`${app.origin}/choirs/visual-choir`);
      const fab = page.getByRole("button", { name: "上传 PDF", exact: true });
      await fab.focus();
      await page.evaluate(() => window.scrollTo(0, 500));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
      await expect(fab).toBeFocused();
      await fab.press("Enter");
      await expect(page.getByRole("dialog", { name: "上传 PDF", exact: true })).toBeVisible();
    });
    await scenario("empty-search-upload", async page => {
      await page.goto(`${app.origin}/choirs/visual-choir`);
      const fab = page.getByRole("button", { name: "上传 PDF", exact: true });
      await page.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).fill("不存在");
      await page.getByText(/没有找到包含/).waitFor();
      await fab.click();
      await expect(page.getByRole("dialog", { name: "上传 PDF", exact: true })).toBeVisible();
    });
  });
}
