import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit, request } from "@playwright/test";
import { expectSampleScoreContent } from "./pdf-content.mjs";
import { startStorageFixture } from "./storage-fixture.mjs";

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${engineName}: ${engineName === "chromium" ? "offline browser restart" : "API outage on a new page"} restores home, drive and reader`, { timeout: 120_000 }, async t => {
    const fixture = await startStorageFixture({ authenticated: true, previewEntry: false });
    const profile = await mkdtemp(path.join(tmpdir(), "same-page-offline-entry-"));
    let context = await engine.launchPersistentContext(profile, { headless: true, serviceWorkers: "allow", viewport: { width: 390, height: 844 } });
    t.after(async () => { await context.close(); await fixture.stop(); await rm(profile, { recursive: true, force: true }); });
    const account = fixture.accounts[1];
    const login = await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    const drive = `${fixture.origin}/choirs/${fixture.choirId}`;
    await page.goto(drive);
    await page.getByRole("button", { name: "此云盘设置", exact: true }).waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.getByRole("button", { name: /^离线副本：/ }).click();
    await page.getByRole("button", { name: "下载离线副本", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /^可离线使用$/ }).waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    if (engineName === "chromium") {
      await context.close();
      context = await engine.launchPersistentContext(profile, { headless: true, serviceWorkers: "allow", viewport: { width: 390, height: 844 } });
    } else {
      // Playwright WebKit does not restore its service-worker registration across
      // process launches or an offline new-page navigation here. API failure
      // injection tests cold JS state while static assets remain online; installed iOS
      // PWA process-restart acceptance remains a separate real-device check.
      // WebKit routing does not intercept service-worker requests. Remove the
      // registration after the product verified its download, then inject API
      // failure for the new page. This is not an offline app-shell test.
      await page.evaluate(async () => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
      });
      await context.addInitScript(() => {
        navigator.serviceWorker.register = async () => { throw new Error("Service worker disabled for API-outage fixture"); };
      });
      await page.close();
    }
    if (engineName === "chromium") await context.setOffline(true);
    else await context.route("**/api/**", route => route.abort("internetdisconnected"));
    const offline = await context.newPage();
    const sessionResponses = [];
    const sessionRequests = [];
    const errors = [];
    offline.on("pageerror", error => errors.push(error.message));
    offline.on("request", request => { if (request.url().includes("/auth/")) sessionRequests.push(new URL(request.url()).pathname); });
    offline.on("requestfailed", request => { if (request.url().includes("/auth/")) errors.push(request.failure()?.errorText); });
    offline.on("response", response => { if (response.url().includes("/api/auth/get-session")) sessionResponses.push(response.status()); });
    await offline.goto(fixture.origin);
    try { await offline.getByRole("link").filter({ hasText: fixture.fileName.replace(/\.pdf$/i, "") }).waitFor({ timeout: 10_000 }); }
    catch {
      await mkdir("artifacts/verification/offline-entry", { recursive: true });
      await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-failure.png` });
      assert.fail(JSON.stringify({ headings: await offline.locator("h1,h2").allTextContents(), notices: await offline.locator('[role="status"]').allTextContents(), sessionRequests, sessionResponses, errors }));
    }
    assert.equal(await offline.getByRole("heading", { name: "Harmony begins on the Same Page" }).count(), 0);
    await mkdir("artifacts/verification/offline-entry", { recursive: true });
    await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-home.png` });
    assert.equal(new URL(offline.url()).pathname, `/choirs/${fixture.choirId}`);
    await offline.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).waitFor();
    await offline.getByRole("combobox", { name: "乐谱排序" }).selectOption("updated");
    await offline.reload();
    await offline.getByRole("link").filter({ hasText: fixture.fileName.replace(/\.pdf$/i, "") }).waitFor();
    assert.equal(await offline.getByRole("combobox", { name: "乐谱排序" }).inputValue(), "updated");
    assert.equal(await offline.getByRole("heading", { name: "本机内容" }).count(), 0);
    await offline.getByRole("button", { name: "打开云盘菜单" }).click();
    await offline.getByRole("link", { name: "返回所有云盘", exact: true }).click();
    await offline.getByRole("link").filter({ hasText: "本地链路云盘" }).click();
    await offline.goto(drive);
    await offline.getByRole("heading", { name: "本地链路云盘" }).waitFor();
    await offline.getByRole("link").filter({ hasText: fixture.fileName.replace(/\.pdf$/i, "") }).click();
    await expectSampleScoreContent(offline);
    const readerUrl = offline.url();
    await offline.locator(".reader-shell").click({ position: { x: 195, y: 350 } });
    await offline.getByRole("button", { name: "编辑", exact: true }).click();
    await offline.getByRole("button", { name: "完成编辑", exact: true }).waitFor();
    const reconnected = offline.waitForResponse(response => response.url().includes("/api/auth/get-session") && response.status() === 200);
    if (engineName === "chromium") {
      await context.setOffline(false);
      // Network emulation does not consistently deliver the OS online event.
      await offline.evaluate(() => window.dispatchEvent(new Event("online")));
    }
    else {
      await context.unroute("**/api/**");
      await offline.evaluate(() => window.dispatchEvent(new Event("online")));
    }
    try { await reconnected; } catch {
      assert.fail(JSON.stringify({ sessionResponses, sessionRequests, errors, online: await offline.evaluate(() => navigator.onLine), connectionNotice: await offline.locator('[role="status"]').allTextContents() }));
    }
    assert.equal(offline.url(), readerUrl);
    assert.equal(await offline.getByRole("button", { name: "完成编辑", exact: true }).getAttribute("aria-pressed"), "true");
    await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-reconnected-editing.png` });
    await offline.getByRole("button", { name: "完成编辑", exact: true }).click();
    await offline.getByRole("button", { name: "返回云盘", exact: true }).click();
    await offline.getByRole("searchbox").fill(fixture.fileName.replace(/\.pdf$/i, ""));
    await offline.getByRole("combobox", { name: "乐谱排序" }).selectOption("updated");
    const admin = await request.newContext({ baseURL: fixture.origin, extraHTTPHeaders: { origin: fixture.origin } });
    t.after(() => admin.dispose());
    const owner = fixture.accounts[0];
    assert.equal((await admin.post("/api/auth/sign-in/email", { data: { email: owner.email, password: owner.password } })).status(), 200);
    const memberships = await (await admin.get(`/api/choirs/${fixture.choirId}/memberships`)).json();
    const target = memberships.memberships.find(member => member.id !== memberships.actorId);
    assert.ok(target);
    assert.equal((await admin.post(`/api/choirs/${fixture.choirId}/memberships/${target.id}`, { data: { action: "remove", expectedRevision: target.revision } })).status(), 200);
    await offline.reload();
    await offline.getByRole("heading", { name: "本机保留的乐谱", exact: true }).waitFor();
    await offline.getByText("已无法访问此云盘，以下为本机保留内容", { exact: true }).waitFor();
    assert.equal(await offline.getByRole("combobox", { name: "乐谱排序" }).inputValue(), "updated");
    assert.equal(await offline.getByRole("searchbox").inputValue(), fixture.fileName.replace(/\.pdf$/i, ""));
    await offline.getByRole("link", { name: new RegExp(fixture.fileName.replace(/\.pdf$/i, "")) }).waitFor();
    await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-revoked-mobile.png` });
    await offline.setViewportSize({ width: 1280, height: 900 });
    await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-revoked-desktop.png` });
    await offline.getByRole("link", { name: new RegExp(fixture.fileName.replace(/\.pdf$/i, "")) }).click();
    await expectSampleScoreContent(offline);

  });
}
