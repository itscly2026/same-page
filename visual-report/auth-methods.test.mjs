import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let server;
before(async () => {
  server = await startVisualServer({ script: "dev", cwd: repositoryRoot });
  if (process.env.LAYOUT_CAPTURE_DIR) await mkdir(process.env.LAYOUT_CAPTURE_DIR, { recursive: true });
});
after(async () => server?.stop());

for (const [name, engine, viewport] of [
  ["phone", chromium, { width: 390, height: 844 }],
  ["desktop", webkit, { width: 1440, height: 1000 }],
]) {
  test(`${name}: first password setup, retry and continuation fit the auth layout`, async t => {
    const browser = await engine.launch();
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    let flow = "set-password";
    let verificationAttempts = 0;
    let passwordSet = false;
    await page.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const json = body => route.fulfill({ json: body });
      if (pathname === "/api/auth/social-providers") return json({ providers: ["google"] });
      if (pathname === "/api/auth/flow") return json(flow === "set-password" ? { flow, hasGoogle: true } : { flow });
      if (pathname === "/api/auth/email-otp/request-password-reset") return json({ success: true });
      if (pathname === "/api/auth/email-otp/check-verification-otp") {
        if (++verificationAttempts === 1) return route.fulfill({ status: 400, json: { error: "invalid_otp" } });
        return json({ success: true });
      }
      if (pathname === "/api/auth/email-otp/reset-password") { passwordSet = true; return json({ success: true }); }
      if (pathname === "/api/auth/sign-in/email") {
        assert.equal(passwordSet, true);
        return json({ token: "local-fixture", user: { id: "fixture-user" } });
      }
      const fixture = resolveFixtureRequest({ pathname, method: request.method(), scenarioId: "auth-login" });
      return route.fulfill(fixture ?? { status: 404, json: {} });
    });
    await page.goto(`${server.origin}/login`);
    await page.getByLabel("邮箱", { exact: true }).fill("singer@example.test");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect(page.getByText("你此前通过 Google 登录，尚未设置合谱密码")).toBeVisible();
    await expect(page.getByRole("button", { name: "使用 Google 继续" })).toBeVisible();
    const googleBounds = await page.getByRole("button", { name: "使用 Google 继续" }).boundingBox();
    assert.ok(googleBounds.height >= 44, "Google action must be at least 44px high");
    await screenshot(page, name, "methods");
    await page.getByRole("button", { name: "设置密码，以后用邮箱登录" }).click();
    await page.getByLabel("六位验证码").fill("123456");
    await page.getByRole("button", { name: "验证邮箱", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("验证码错误");
    await expect(page.getByRole("button", { name: /重新发送验证码/ })).toBeDisabled();
    await page.getByRole("button", { name: "验证邮箱", exact: true }).click();
    await expect(page.getByLabel("密码（至少 10 位）", { exact: true })).toBeVisible();
    await screenshot(page, name, "password");
    await page.getByRole("button", { name: "返回验证邮箱" }).click();
    await expect(page.getByLabel("六位验证码")).toBeVisible();
    await page.getByRole("button", { name: "验证邮箱", exact: true }).click();
    await page.getByLabel("密码（至少 10 位）", { exact: true }).fill("local fixture password");
    await page.getByLabel("确认密码", { exact: true }).fill("local fixture password");
    await page.getByRole("button", { name: "设置密码并登录" }).click();
    await expect(page.getByText("密码已设置，以后可以使用邮箱密码或 Google 登录")).toBeVisible();
    await screenshot(page, name, "complete");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login/);
    flow = "sign-in";
    await page.goto(`${server.origin}/login`);
    await page.getByLabel("邮箱", { exact: true }).fill("singer@example.test");
    await page.getByRole("button", { name: "继续", exact: true }).click();
    await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "使用 Google 继续" })).toBeVisible();
    await screenshot(page, name, "sign-in");
  });
}

async function screenshot(page, device, step) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert.ok(dimensions.content <= dimensions.viewport, `${device}/${step} must not overflow`);
  if (process.env.LAYOUT_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.LAYOUT_CAPTURE_DIR, `auth-${device}-${step}.png`), fullPage: true });
}
