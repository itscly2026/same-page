import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";
import { createVisualFixtureSession } from "./fixtures.mjs";
import { startVisualServer } from "./setup.mjs";

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: simplified settings, permission matrix, sharing and export`, async t => {
    const app = await startVisualServer({ script: "dev" });
    const profile = await mkdtemp(path.join(os.tmpdir(), "same-page-ui204-"));
    const context = await engine.launchPersistentContext(profile, { viewport: { width: 1100, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
    t.after(async () => { await context.close(); await app.stop(); await rm(profile, { recursive: true, force: true }); });
    const fixture = createVisualFixtureSession();
    const writes = [];
    let sharing = false;
    let delegated = false;
    await context.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postDataJSON();
      if (method !== "GET") writes.push({ pathname, body });
      if (pathname === "/api/user/lifecycle") return route.fulfill({ json: { userId: "visual-user-admin", deletion: null, reauthenticated: false, methods: ["credential"], memberships: [] } });
      if (/\/personal-layers\/[^/]+$/.test(pathname)) { sharing = body.sharing; return route.fulfill({ json: { sharing } }); }
      if (method === "PUT" && pathname.endsWith("/permissions")) return route.fulfill({ status: 204 });
      const response = fixture.resolve({ pathname, method, body, identity: "admin", cookie: request.headers().cookie ?? "" });
      if (pathname.endsWith("/layers")) {
        const data = JSON.parse(response.body);
        data.layers = data.layers.map(layer => layer.kind === "personal" ? { ...layer, canShare: true, sharing } : layer);
        response.body = JSON.stringify(data);
      }
      if (pathname.endsWith("/memberships") && delegated) {
        const data = JSON.parse(response.body);
        data.capabilities = { isOwner: false, operations: { operations: [], sharedLayers: [] }, management: { operations: ["uploadFiles"], sharedLayers: ["S"] } };
        data.actorId = "another-delegate";
        response.body = JSON.stringify(data);
      }
      return route.fulfill(response);
    });
    await context.addInitScript(() => {
      localStorage.setItem("reader-gesture-hint-seen", "true");
      // UI fixture only: exercise verified PDF activation without a production SW.
      navigator.serviceWorker.getRegistration = async () => ({ active: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const output = "artifacts/verification/ui-204";
    await mkdir(output, { recursive: true });
    const capture = async name => {
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/${engineName}-${name}.png`, fullPage: name.startsWith("permissions-") });
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
    await capture("permissions-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("permissions-mobile");
    const info = page.getByRole("button", { name: "上传文件说明" });
    await info.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText("不包含修改、删除");
    await capture("permission-info");
    await page.keyboard.press("Escape"); await expect(info).toBeFocused();
    await page.getByText("成员操作", { exact: true }).click();
    await page.getByRole("button", { name: "移除 周宁" }).click();
    await expect(page.getByRole("dialog", { name: "移除成员" })).toBeVisible();
    await capture("remove-confirmation");
    await page.getByRole("dialog", { name: "移除成员" }).getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(writes.some(write => write.body?.action === "remove"), false);
    delegated = true; await page.reload(); await page.getByText("周宁", { exact: true }).click();
    await page.locator("details.lifecycle-member").filter({ has: page.getByRole("heading", { name: "周宁", exact: true }) }).getByText("编辑权限", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "上传文件：可以操作" })).toBeVisible();
    assert.equal(await page.getByRole("checkbox", { name: /可以授权他人/ }).count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: /修改文件/ }).count(), 0);
    await page.getByText("林老师", { exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "保存 林老师 的权限" }).count(), 0);
    delegated = false;
    await page.goto(drive);
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    await expect(page.getByRole("dialog", { name: "云盘菜单" })).toBeVisible();
    await capture("drive-settings");
    await page.keyboard.press("Escape");
    await page.goto(`${app.origin}/user`);
    await expect(page.getByRole("link", { name: "删除用户" })).toBeVisible();
    assert.equal(await page.getByRole("button", { name: "重新验证原登录方式" }).count(), 0);
    await capture("personal-settings");
    await page.getByRole("link", { name: "删除用户" }).click();
    await expect(page.getByRole("button", { name: "重新验证原登录方式" })).toBeVisible();
    await capture("delete-secondary");
    await page.setViewportSize({ width: 834, height: 1194 });
    await page.goto(`${drive}/scores/visual-score`);
    await page.locator("canvas[data-pdf-canvas-active]").first().waitFor();
    await page.locator(".page-reader__viewport").click();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByText("可离线使用", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "下载离线副本", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "立即同步", exact: true }).count(), 0);
    await capture("reader-options");
    await page.getByRole("button", { name: "关闭更多阅读选项" }).click();
    await page.getByRole("button", { name: "看哪些笔记", exact: true }).click();
    await page.getByRole("button", { name: "管理 我的笔记", exact: true }).click();
    const shareToggle = page.getByRole("button", { name: "分享 我的笔记", exact: true });
    await expect(shareToggle).toHaveText("分享给云盘成员");
    await capture("share-notes");
    await shareToggle.click();
    await expect(shareToggle).toHaveText("停止分享");
    await expect(shareToggle).toBeEnabled();
    await shareToggle.click();
    await expect(shareToggle).toHaveText("分享给云盘成员");
    await expect(shareToggle).toBeEnabled();
    assert.deepEqual(writes.filter(write => /\/personal-layers\/[^/]+$/.test(write.pathname)).map(write => write.body.sharing), [true, false]);
    await page.getByRole("checkbox", { name: "显示 Ensemble" }).waitFor();
    await capture("display-layers");
    await page.getByRole("dialog", { name: "看哪些笔记" }).getByRole("button", { name: "关闭笔记显示" }).click();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "导出 PDF", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "导出 PDF" });
    await dialog.getByRole("button", { name: "取消全部笔记" }).click();
    assert.equal(await dialog.locator('input:checked').count(), 0);
    assert.equal(writes.some(write => write.pathname.endsWith("/preference")), false);
    await capture("export-original");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "导出 PDF", exact: true }).click();
    assert.equal((await download).suggestedFilename().endsWith(".pdf"), true);
    await page.goto(`${drive}/storage`);
    await expect(page.getByRole("button", { name: /^移除 排练示例.*的离线副本/ })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("local-storage");
  });
}
