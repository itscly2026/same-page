import assert from "node:assert/strict";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";
import { createVisualFixtureSession } from "./fixtures.mjs";
import { startVisualServer } from "./setup.mjs";

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: permission editing separates operation rights from delegation and confirms removal`, async t => {
    const app = await startVisualServer({ script: "dev" });
    t.after(() => app.stop());
    const browser = await engine.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
    const fixture = createVisualFixtureSession();
    const writes = [];
    let delegated = false;
    await context.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postDataJSON();
      if (method !== "GET") writes.push({ pathname, body });
      if (method === "PUT" && pathname.endsWith("/permissions")) return route.fulfill({ status: 204 });
      const response = fixture.resolve({ pathname, method, body, identity: "admin", cookie: request.headers().cookie ?? "" });
      if (pathname.endsWith("/memberships") && delegated) {
        const data = JSON.parse(response.body);
        data.capabilities = { isOwner: false, operations: { operations: [], sharedLayers: [] }, management: { operations: ["uploadFiles"], sharedLayers: ["S"] } };
        data.actorId = "another-delegate";
        response.body = JSON.stringify(data);
      }
      return route.fulfill(response);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const assertFits = async () => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    const drive = `${app.origin}/choirs/visual-choir`;
    await page.goto(`${drive}/memberships`);
    await page.getByText("周宁", { exact: true }).click();
    await page.locator("details.lifecycle-member").filter({ has: page.getByRole("heading", { name: "周宁", exact: true }) }).getByText("编辑权限", { exact: true }).click();
    await page.getByRole("checkbox", { name: "上传文件：可以操作" }).uncheck();
    await page.getByRole("checkbox", { name: "修改文件：可以操作" }).check();
    await expect(page.getByRole("checkbox", { name: "修改文件：可以授权他人" })).not.toBeChecked();
    await page.getByRole("button", { name: "保存 周宁 的权限" }).click();
    assert.deepEqual(writes.find(write => write.pathname.endsWith("/permissions")).body.management, { operations: [], sharedLayers: [] });
    await assertFits();
    await page.setViewportSize({ width: 390, height: 844 });
    await assertFits();
    const info = page.getByRole("button", { name: "上传文件说明" });
    await info.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("不包含修改、删除");
    await assertFits();
    await page.keyboard.press("Escape"); await expect(info).toBeFocused();
    await page.getByText("成员操作", { exact: true }).click();
    await page.getByRole("button", { name: "移除 周宁" }).click();
    await expect(page.getByRole("dialog", { name: "移除成员" })).toBeVisible();
    await assertFits();
    await page.getByRole("dialog", { name: "移除成员" }).getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(writes.some(write => write.body?.action === "remove"), false);
    delegated = true; await page.reload(); await page.getByText("周宁", { exact: true }).click();
    await page.locator("details.lifecycle-member").filter({ has: page.getByRole("heading", { name: "周宁", exact: true }) }).getByText("编辑权限", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "上传文件：可以操作" })).toBeVisible();
    assert.equal(await page.getByRole("checkbox", { name: /可以授权他人/ }).count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: /修改文件/ }).count(), 0);
    await page.getByText("林老师", { exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "保存 林老师 的权限" }).count(), 0);
  });
}
