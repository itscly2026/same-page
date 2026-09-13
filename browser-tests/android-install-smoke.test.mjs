import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

test("Android installation offers APK only outside WeChat and keeps PWA user-triggered", { timeout: 120000 }, async t => {
  const fixture = await startStorageFixture({ invite: true }); t.after(() => fixture.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const evidence = "artifacts/verification/android-install";
  await mkdir(evidence, { recursive: true });
  for (const embedded of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: `Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/139.0.0.0 Mobile Safari/537.36${embedded ? " MicroMessenger/8.0" : ""}` });
    const page = await context.newPage();
    let releaseRequests = 0;
    await page.route("**/api/android-release", route => {
      releaseRequests++;
      return route.fulfill({ json: { release: { versionName: "1.0.0", versionCode: 1, size: 2514417, sha256: "a".repeat(64) } } });
    });
    await page.goto(`${fixture.origin}/?join=1#${new URLSearchParams({ invite: fixture.joinCode })}`);
    await expect(page.getByRole("heading", { name: "本地链路云盘", exact: true })).toBeVisible();
    await page.evaluate(() => {
      window.installPromptCalls = 0;
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.defineProperty(event, "prompt", { value: async () => { window.installPromptCalls++; return { outcome: "dismissed" }; } });
      window.dispatchEvent(event);
    });
    await page.getByRole("button", { name: embedded ? "添加到主屏幕" : "安装合谱", exact: true }).click();
    if (embedded) {
      await expect(page.getByText("点右上角 ···", { exact: false })).toBeVisible();
      await expect(page.getByText("下载 Android 安装包")).toHaveCount(0);
      assert.equal(releaseRequests, 0);
    } else {
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("link", { name: "下载 Android 安装包" })).toBeVisible();
      assert.equal(await page.evaluate(() => window.installPromptCalls), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${evidence}/android-browser.png` });
      await dialog.getByRole("button", { name: "添加到主屏幕", exact: true }).click();
      assert.equal(await page.evaluate(() => window.installPromptCalls), 1);
    }
    if (embedded) await page.screenshot({ path: `${evidence}/android-wechat.png` });
    await context.close();
  }
});
