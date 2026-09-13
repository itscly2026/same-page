import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

test("invited guest crosses isolated browsers and cold-starts with only the copied cookie", { timeout: 120000 }, async t => {
  const fixture = await startStorageFixture({ invite: true, authenticated: true });
  t.after(() => fixture.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const wechat = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0" });
  const page = await wechat.newPage();
  await page.goto(`${fixture.origin}/?join=1#${new URLSearchParams({ invite: fixture.joinCode })}`);
  await expect(page.getByRole("heading", { name: "本地链路云盘", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "安装建议" })).toBeVisible();
  await mkdir("artifacts/verification/install-onboarding", { recursive: true });
  await page.screenshot({ path: "artifacts/verification/install-onboarding/01-drive.png" });
  await page.getByRole("button", { name: "添加到主屏幕", exact: true }).click();
  await expect(page.getByText("点右上角 ···", { exact: false })).toBeVisible();
  // Keep bearer URLs in memory only; screenshots and assertion output omit them.
  const bridge = page.url();
  assert.equal(new URL(bridge).pathname, "/install");
  assert.ok(new URL(bridge).hash.startsWith("#handoff="));
  await page.screenshot({ path: "artifacts/verification/install-onboarding/02-wechat.png" });
  const safari = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" });
  const external = await safari.newPage();
  external.on("request", request => {
    if (new URL(request.url()).pathname === "/api/guest/install-handoff/redeem") assert.equal(new URL(external.url()).hash, "");
  });
  await external.goto(bridge);
  await expect(external.getByText("点分享按钮", { exact: false })).toBeVisible();
  assert.equal(new URL(external.url()).hash, "");
  await external.screenshot({ path: "artifacts/verification/install-onboarding/03-safari.png" });
  await external.getByRole("link", { name: "先看乐谱" }).click();
  await expect(external.getByRole("heading", { name: "本地链路云盘", exact: true })).toBeVisible();
  await external.getByRole("button", { name: "添加到主屏幕", exact: true }).click();
  await external.getByText("添加时遇到问题？", { exact: true }).click();
  await expect(external.getByRole("textbox", { name: "合谱网址" })).toHaveValue(/\/install\?drive=.*#handoff=/);
  const cookies = await safari.cookies();
  assert.ok(cookies.some(cookie => cookie.name === "same_page_guest"));
  // Models Safari 17.2+ documented cookie-copy contract, not actual OS install.
  const installed = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await installed.addCookies(cookies);
  const launched = await installed.newPage();
  await launched.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => query === "(display-mode: standalone)" ? { ...original(query), matches: true, addEventListener() {}, removeEventListener() {} } : original(query);
  });
  await launched.goto(fixture.origin);
  await expect(launched.getByRole("heading", { name: "本地链路云盘", exact: true })).toBeVisible();
  await expect(launched.getByRole("complementary", { name: "安装建议" })).toHaveCount(0);
  await expect(launched.locator(".file-row__open")).toHaveCount(1);
  // Explicit home navigation must still stay home.
  await launched.getByRole("button", { name: "打开云盘菜单" }).click();
  await launched.getByRole("link", { name: "云盘列表", exact: true }).click();
  await expect(launched).toHaveURL(fixture.origin + "/drives");
  // A guest cannot mint a bridge to an unrelated drive.
  assert.equal((await safari.request.post(`${fixture.origin}/api/guest/install-handoff`, { data: { choirId: "other" } })).status(), 401);
  const fresh = await browser.newContext();
  assert.equal((await fresh.request.post(`${fixture.origin}/api/guest/install-handoff`, { data: { choirId: fixture.choirId } })).status(), 401);
  const android = await browser.newContext({ viewport: { width: 360, height: 800 }, userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36" });
  const androidPage = await android.newPage();
  await androidPage.goto(bridge);
  await expect(androidPage.getByText("打开浏览器菜单 ⋮", { exact: false })).toBeVisible();
  await expect(androidPage.getByText("添加时遇到问题？").locator("..")).not.toHaveAttribute("open");
  assert.equal(await androidPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await androidPage.screenshot({ path: "artifacts/verification/install-onboarding/04-android.png" });
  await androidPage.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.defineProperty(event, "prompt", { value: async () => ({ outcome: "accepted" }) });
    window.dispatchEvent(event);
  });
  await androidPage.getByRole("button", { name: "安装合谱", exact: true }).click();
  await androidPage.getByRole("dialog").getByRole("button", { name: "添加到主屏幕", exact: true }).click();
  await expect(androidPage.getByRole("dialog").getByText("主屏幕没有合谱图标？")).toBeVisible();
  await androidPage.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await androidPage.getByRole("button", { name: "关闭安装引导" }).click();
  const recovery = androidPage.getByText("主屏幕没有合谱图标？");
  await expect(recovery).toBeVisible();
  await expect(recovery.locator("..")).not.toHaveAttribute("open");
  await recovery.click();
  await expect(androidPage.getByText(/允许“创建桌面快捷方式”/)).toBeVisible();
  await androidPage.screenshot({ path: "artifacts/verification/install-onboarding/05-android-recovery.png" });
  await android.close();
  const owner = fixture.accounts[0];
  assert.equal((await fresh.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: owner.email, password: owner.password } })).status(), 200);
  assert.equal((await fresh.request.post(`${fixture.origin}/api/choirs/${fixture.choirId}/join-code/rotate`)).status(), 200);
  const token = new URLSearchParams(new URL(bridge).hash.slice(1)).get("handoff");
  assert.equal((await safari.request.post(`${fixture.origin}/api/guest/install-handoff/redeem`, { data: { token } })).status(), 401);
  for (const context of [wechat, safari, installed, fresh]) await context.close();
});
