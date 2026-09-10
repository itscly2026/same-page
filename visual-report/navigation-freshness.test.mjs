import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";
import { withBrowserEvidence } from "../browser-tests/browser-evidence.mjs";

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: ten information round trips reuse confirmed navigation`, async t => {
    const app = await startVisualServer({ script: "dev" }); t.after(() => app.stop());
    const browser = await engine.launch(); t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    t.after(() => context.close());
    await withBrowserEvidence(context, `artifacts/verification/navigation-freshness/${name}`, async () => {
      const page = await context.newPage();
      const fixture = createVisualFixtureSession();
      const counts = {};
      let releaseBootstrap;
      await page.clock.setFixedTime(new Date("2026-09-10T00:00:00Z"));
      await page.route("**/api/**", async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        counts[pathname] = (counts[pathname] ?? 0) + 1;
        if (pathname.endsWith("/bootstrap") && counts[pathname] > 1) await new Promise(resolve => { releaseBootstrap = resolve; });
        if (pathname === "/api/choirs/visual-choir/settings") return route.fulfill({ json: { name: "示例云盘", nameRevision: 0, displayName: "管理员", membershipRevision: 0, canEditDriveInfo: true } });
        if (pathname.endsWith("/usage")) return route.fulfill({ json: { plan: "configured", usedBytes: 0, limitBytes: 1000, scoreCount: 1, scoreLimit: null, memberCount: 1, memberLimit: null } });
        await route.fulfill(fixture.resolve({ pathname, method: request.method(), identity: "admin", cookie: "" }));
      });
      await page.goto(`${app.origin}/choirs/visual-choir`);
      await page.getByRole("button", { name: "打开云盘菜单" }).click();
      await page.getByRole("link", { name: "基本信息", exact: true }).waitFor();
      for (let i = 0; i < 10; i++) {
        await page.getByRole("link", { name: "基本信息", exact: true }).click();
        await page.getByRole("button", { name: "修改云盘名称", exact: true }).waitFor();
        await expect(page.getByRole("button", { name: "修改云盘名称", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "返回", exact: true }).click();
        await page.getByRole("link", { name: "基本信息", exact: true }).waitFor();
        await expect(page.getByText("正在确认访问权限，已有内容可以继续浏览。")).toHaveCount(0);
      }
      assert.equal(counts["/api/choirs/visual-choir/bootstrap"], 1);
      assert.equal(counts["/api/choirs/visual-choir/management"], 1);
      assert.equal(counts["/api/choirs/visual-choir/settings"], 1);
      assert.equal(counts["/api/choirs/visual-choir/usage"], 1);
      assert.equal(counts["/api/choirs/visual-choir/memberships"] ?? 0, 0);
      await page.clock.setFixedTime(new Date("2026-09-10T00:01:01Z"));
      await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
      await expect.poll(() => counts["/api/choirs/visual-choir/bootstrap"]).toBe(2);
      await expect(page.getByRole("link", { name: "基本信息", exact: true })).toBeVisible();
      await expect(page.getByText("正在确认访问权限，已有内容可以继续浏览。")).toHaveCount(0);
      releaseBootstrap();
      await expect(page.getByRole("button", { name: "刷新乐谱列表" })).not.toHaveAttribute("aria-disabled", "true");
      await page.screenshot({ path: `artifacts/verification/navigation-freshness/${name}/warm-return.png` });
    });
  });
}
