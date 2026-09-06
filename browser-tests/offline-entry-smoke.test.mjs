import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${engineName}: ${engineName === "chromium" ? "offline browser restart" : "API outage on a new page"} restores home, drive and reader`, { timeout: 120_000 }, async t => {
    const fixture = await startStorageFixture({ authenticated: true });
    const profile = await mkdtemp(path.join(tmpdir(), "same-page-offline-entry-"));
    let context = await engine.launchPersistentContext(profile, { headless: true, serviceWorkers: "allow", viewport: { width: 390, height: 844 } });
    t.after(async () => { await context.close(); await fixture.stop(); await rm(profile, { recursive: true, force: true }); });
    const account = fixture.accounts[1];
    const login = await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    const drive = `${fixture.origin}/choirs/${fixture.choirId}`;
    await page.goto(drive);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.getByRole("button", { name: /^下载离线副本：/ }).click();
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
      await page.close();
    }
    if (engineName === "chromium") await context.setOffline(true);
    else await context.route("**/api/**", route => route.abort("internetdisconnected"));
    const offline = await context.newPage();
    await offline.goto(fixture.origin);
    await offline.getByRole("link").filter({ hasText: fixture.fileName }).waitFor();
    assert.equal(await offline.getByRole("heading", { name: "Harmony begins on the Same Page" }).count(), 0);
    await mkdir("artifacts/verification/offline-entry", { recursive: true });
    await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-home.png` });
    await offline.goto(drive);
    await offline.getByRole("heading", { name: "本地链路云盘" }).waitFor();
    await offline.getByRole("link").filter({ hasText: fixture.fileName }).click();
    await offline.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
    const readerUrl = offline.url();
    await offline.locator(".reader-shell").click({ position: { x: 195, y: 350 } });
    await offline.getByRole("button", { name: "编辑", exact: true }).click();
    await offline.getByRole("button", { name: "完成编辑", exact: true }).waitFor();
    const reconnected = offline.waitForResponse(response => response.url().includes("/api/auth/get-session") && response.status() === 200);
    if (engineName === "chromium") await context.setOffline(false);
    else {
      await context.unroute("**/api/**");
      await offline.evaluate(() => window.dispatchEvent(new Event("online")));
    }
    await reconnected;
    assert.equal(offline.url(), readerUrl);
    assert.equal(await offline.getByRole("button", { name: "完成编辑", exact: true }).getAttribute("aria-pressed"), "true");
    await offline.screenshot({ path: `artifacts/verification/offline-entry/${engineName}-reconnected-editing.png` });
  });
}
