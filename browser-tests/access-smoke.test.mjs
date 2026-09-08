import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

test("literal search, verified offline read and failed/successful immutable PDF replacement", { timeout: 90000 }, async t => {
  const fixture = await startStorageFixture({ authenticated: true });
  t.after(() => fixture.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const account = fixture.accounts[0];
  assert.equal((await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } })).status(), 200);
  const base = `${fixture.origin}/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
  const name = "合唱排练".repeat(31) + "%_终曲.pdf";
  assert.equal((await context.request.patch(base, { data: { fileName: name } })).status(), 200);
  const searched = await context.request.get(`${fixture.origin}/api/choirs/${fixture.choirId}/bootstrap?q=${encodeURIComponent(name)}`);
  assert.equal(searched.status(), 200); assert.equal((await searched.json()).scores[0].id, fixture.scoreId);
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/choirs/${fixture.choirId}`);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.getByRole("searchbox").fill("%_");
  await expect(page.locator(".file-row__open")).toHaveCount(1);
  await page.getByRole("button", { name: /^离线副本：/ }).click();
  await page.getByRole("button", { name: "下载离线副本", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^可离线使用$/ }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".file-row__open").click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
  await context.setOffline(true);
  await page.reload();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
  await context.setOffline(false);
  const versions = await (await context.request.get(`${base}/versions`)).json();
  const staged = await context.request.post(`${base}/versions`, { multipart: { expectedRevision: String(versions.revision), file: { name: "新版", mimeType: "application/pdf", buffer: fixture.pdf } } });
  assert.equal(staged.status(), 201);
  const version = (await staged.json()).version;
  assert.equal((await context.request.post(`${base}/versions/${version.id}/publish`, { data: { expectedRevision: versions.revision } })).status(), 204);
  await page.goto(`${fixture.origin}/choirs/${fixture.choirId}`);
  await expect(page.getByRole("button", { name: /^离线副本：.*旧版可离线使用/ })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^需更新$/ })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: /^离线副本：/ })).toBeDisabled();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: /^离线副本：/ })).toBeEnabled();
  // Fail just this download after submission, while retaining the real offline
  // browser refresh above and all subsequent storage/checksum verification.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).endsWith("/pdf")) { window.fetch = original; return Promise.reject(new TypeError("injected download failure")); }
      return original(...args);
    };
  });
  await page.getByRole("button", { name: /^离线副本：/ }).click();
  await page.getByRole("button", { name: "下载新版离线副本", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /下载未完成/ }).waitFor();
  await expect(page.getByRole("status").filter({ hasText: /下载未完成/ })).toContainText("旧版 PDF 仍可离线使用");
  await context.setOffline(false);
  await page.getByRole("button", { name: "重试下载", exact: true }).click();
  await page.getByRole("status").filter({ hasText: /^可离线使用$/ }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".file-row__open").click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
  await mkdir("artifacts/verification", { recursive: true });
  await page.screenshot({ path: "artifacts/verification/access-136.png" });
});

test("expired but uncleaned trash cannot be restored through a real browser session", { timeout: 60000 }, async t => {
  const fixture = await startStorageFixture({ authenticated: true, expired: true });
  t.after(() => fixture.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const account = fixture.accounts[0];
  assert.equal((await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } })).status(), 200);
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/choirs/${fixture.choirId}`);
  const restored = await page.evaluate(async ({ choirId, scoreId }) => (await fetch(`/api/choirs/${choirId}/scores/${scoreId}/restore`, { method: "POST" })).status, { choirId: fixture.choirId, scoreId: fixture.scoreId });
  assert.equal(restored, 404);
  await page.getByRole("button", { name: "打开云盘菜单", exact: true }).click();
  await page.getByRole("link", { name: "回收站", exact: true }).click();
  await expect(page.getByRole("heading", { name: "回收站", exact: true })).toBeVisible();
  await page.getByText("回收站是空的。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "恢复", exact: true }).count(), 0);
});
