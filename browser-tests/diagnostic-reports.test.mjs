import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

// Real Worker/D1 with synthetic data. The first response is lost AFTER real persistence.
test("diagnostic feedback survives lost receipts and preserves reader editing in Chromium/WebKit", { timeout: 150_000 }, async t => {
  const fixture = await startStorageFixture({ authenticated: true, script: "dev" });
  t.after(() => fixture.stop());
  await mkdir("artifacts/verification", { recursive: true });
  for (const [name, engine, width, height] of [["chromium", chromium, 320, 740], ["webkit", webkit, 768, 1024]]) {
    const browser = await engine.launch({ headless: true });
    let activePage;
    try {
      const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
      const page = await context.newPage();
      activePage = page;
      await page.goto(`${fixture.origin}/diagnostics`);
      await expect(page.getByRole("button", { name: "发送诊断", exact: true })).toBeEnabled();
      assert.equal(await page.locator("details").getAttribute("open"), null);
      await page.getByLabel("刚才遇到了什么问题？（选填）").fill("显示不正常，没有报错");
      await page.screenshot({ path: `artifacts/verification/diagnostic-${name}-form.png`, fullPage: true });
      let original, attempts = 0;
      await page.route("**/api/diagnostic-reports", async route => {
        const body = route.request().postDataJSON();
        attempts++;
        if (attempts === 1) {
          original = body;
          const persisted = await route.fetch();
          assert.equal(persisted.status(), 201);
          assert.deepEqual(await persisted.json(), { id: body.id });
          await route.abort("failed");
        } else {
          assert.deepEqual(body, original);
          await route.continue();
        }
      });
      await page.getByRole("button", { name: "发送诊断", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("尚未确认收到");
      await page.screenshot({ path: `artifacts/verification/diagnostic-${name}-uncertain.png`, fullPage: true });
      await page.getByRole("button", { name: "重试发送" }).click();
      await expect(page.getByRole("button", { name: "复制反馈编号" })).toBeVisible();
      await expect(page.locator(".diagnostic-receipt")).toContainText(original.id);
      assert.equal((await context.request.get(`${fixture.origin}/api/diagnostic-reports/${original.id}`)).status(), 404);
      await page.screenshot({ path: `artifacts/verification/diagnostic-${name}-receipt.png`, fullPage: true });
      await page.getByRole("button", { name: "填写另一份反馈" }).click();
      await context.setOffline(true);
      await page.getByRole("button", { name: "发送诊断", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("当前离线");
      assert.equal(attempts, 2);
      await context.setOffline(false);
      await page.unroute("**/api/diagnostic-reports");
      await page.getByRole("button", { name: "清空诊断" }).click();
      const account = fixture.accounts[1];
      const login = await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, {
        headers: { origin: fixture.origin }, data: { email: account.email, password: account.password },
      });
      assert.equal(login.status(), 200);
      await page.goto(`${fixture.origin}/choirs/${fixture.choirId}/scores/${fixture.scoreId}`);
      await page.locator("canvas[data-pdf-canvas-active]").first().waitFor();
      const viewport = page.locator(".page-reader__viewport");
      const bounds = await viewport.boundingBox();
      await viewport.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      await expect(page.getByRole("button", { name: "编辑", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: "更多", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "连续滚动", exact: true }).count(), 0);
      const readerUrl = page.url();
      await page.getByRole("button", { name: "故障诊断", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "故障诊断" });
      await expect(dialog).toBeVisible();
      await dialog.getByText("查看诊断内容", { exact: true }).click();
      const snapshot = JSON.parse(await dialog.getByLabel("可发送给支持人员的诊断内容").inputValue());
      assert.equal(snapshot.reader.interactionMode, "editing");
      assert.equal(snapshot.reader.displayMode, "pdf");
      assert.ok(!JSON.stringify(snapshot).includes(fixture.scoreId));
      assert.ok(!JSON.stringify(snapshot).includes(fixture.fileName));
      await dialog.getByText("查看诊断内容", { exact: true }).click();
      await page.screenshot({ path: `artifacts/verification/diagnostic-${name}-reader.png`, fullPage: true });
      await dialog.getByRole("button", { name: "发送诊断", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "复制反馈编号" })).toBeVisible();
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      assert.equal(page.url(), readerUrl);
      await expect(page.getByRole("button", { name: "编辑", exact: true })).toHaveAttribute("aria-pressed", "true");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await writeFile(`artifacts/verification/diagnostic-${name}.json`, JSON.stringify({ engine: name, viewport: { width, height }, realWorkerD1: true, receiptLostAfterPersistence: true, retainedEditing: true, realDevice: false }, null, 2));
      await context.close();
    } catch (error) {
      await activePage?.screenshot({ path: `artifacts/verification/diagnostic-${name}-failure.png`, fullPage: true });
      throw error;
    } finally { await browser.close(); }
  }
});
