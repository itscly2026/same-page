import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: drive drawer, avatar and scroll-aware upload work on mobile`, async t => {
    const app = await startVisualServer({ script: "dev" });
    const browser = await engine.launch();
    t.after(async () => { await browser.close(); await app.stop(); });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
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
    await page.goto(`${app.origin}/choirs/visual-choir`);
    const fab = page.getByRole("button", { name: "上传 PDF", exact: true });
    await fab.waitFor();
    await page.getByRole("button", { name: "用户菜单" }).getByText("林", { exact: true }).waitFor();
    assert.equal(await page.locator(".brand-link").count(), 0);
    const output = "artifacts/verification/drive-navigation";
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/${name}-library.png` });
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    await page.getByRole("dialog", { name: "云盘菜单" }).waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "成员与权限" }).getAttribute("href"), "/choirs/visual-choir/memberships");
    await page.screenshot({ path: `${output}/${name}-drawer.png` });
    await page.getByRole("button", { name: "切换云盘", exact: true }).click();
    await page.getByRole("dialog", { name: "切换云盘" }).waitFor();
    await page.getByRole("link", { name: /当前云盘/ }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "打开云盘菜单" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("button", { name: "打开云盘菜单" }).evaluate(el => el === document.activeElement), true);
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForFunction(() => document.querySelector(".upload-fab")?.dataset.visible === "false");
    await fab.waitFor({ state: "hidden" });
    assert.equal(await fab.count(), 0, "hidden upload is not in the accessibility tree");
    await page.evaluate(() => window.scrollTo(0, 350));
    await fab.waitFor();
    await fab.click();
    await page.getByRole("dialog", { name: "上传 PDF" }).waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索乐谱" }).fill("不存在");
    await page.getByText(/没有找到包含/).waitFor();
    await fab.waitFor();
    for (const width of [320, 834, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  });
}
