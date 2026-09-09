import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit, request, expect } from "@playwright/test";
import { expectSampleScoreContent } from "./pdf-content.mjs";
import { startStorageFixture } from "./storage-fixture.mjs";
import { withBrowserEvidence } from "./browser-evidence.mjs";

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${engineName}: verified local score access`, async t => {
    const fixture = await startStorageFixture({ authenticated: true, previewEntry: false });
    t.after(() => fixture.stop());
    const drive = `${fixture.origin}/choirs/${fixture.choirId}`;
    const options = { headless: true, serviceWorkers: "allow", viewport: { width: 390, height: 844 } };
    async function scenario(label, run) {
      await t.test(label, { timeout: 120_000 }, async scenarioTest => {
        const profile = await mkdtemp(path.join(tmpdir(), "same-page-offline-entry-"));
        let context;
        // A timed-out recovery must close its browser and allow revocation to run.
        const cleanup = async () => {
          try { await context?.close(); }
          finally { await rm(profile, { recursive: true, force: true }); }
        };
        scenarioTest.after(cleanup);
        try {
          context = await engine.launchPersistentContext(profile, options);
          const account = fixture.accounts[1];
          const login = await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } });
          assert.equal(login.status(), 200);
          const output = `artifacts/verification/offline-entry/${engineName}-${label}`;
          const page = await withBrowserEvidence(context, `${output}/prepare`, async () => {
            const page = await context.newPage();
            await page.goto(drive);
            await page.getByRole("searchbox", { name: "搜索「本地链路云盘」中的乐谱", exact: true }).waitFor();
            await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
            await page.getByRole("button", { name: /^离线副本：/ }).click();
            await page.getByRole("button", { name: "保存供离线使用", exact: true }).click();
            await page.getByRole("status").filter({ hasText: /^可离线使用$/ }).waitFor();
            await page.getByRole("button", { name: "关闭", exact: true }).click();
            return page;
          });
          await run({ page, context, output, restart: async () => {
            await context.close();
            context = await engine.launchPersistentContext(profile, options);
            return context;
          } });
        } finally { await cleanup(); }
      });
    }
    await scenario(engineName === "chromium" ? "offline-browser-restart" : "api-outage-new-page", async ({ page, context, output, restart }) => {
      if (engineName === "chromium") context = await restart();
      await withBrowserEvidence(context, output, async () => {
        if (engineName === "webkit") {
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
        await offline.goto(fixture.origin);
        await offline.getByRole("link").filter({ hasText: fixture.fileName.replace(/\.pdf$/i, "") }).waitFor({ timeout: 10_000 });
        assert.equal(new URL(offline.url()).pathname, `/choirs/${fixture.choirId}`);
        await offline.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).waitFor();
        await offline.getByRole("button", { name: "打开云盘菜单" }).click();
        await offline.getByRole("link", { name: "云盘列表", exact: true }).click();
        await offline.getByRole("link").filter({ hasText: "本地链路云盘" }).click();
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
        await reconnected;
        assert.equal(offline.url(), readerUrl);
        assert.equal(await offline.getByRole("button", { name: "完成编辑", exact: true }).getAttribute("aria-pressed"), "true");
      });
    });
    await scenario("membership-revocation", async ({ page: offline, context, output }) => {
      await withBrowserEvidence(context, output, async () => {
        const admin = await request.newContext({ baseURL: fixture.origin, extraHTTPHeaders: { origin: fixture.origin } });
        try {
          const owner = fixture.accounts[0];
          assert.equal((await admin.post("/api/auth/sign-in/email", { data: { email: owner.email, password: owner.password } })).status(), 200);
          const memberships = await (await admin.get(`/api/choirs/${fixture.choirId}/memberships`)).json();
          const target = memberships.memberships.find(member => member.id !== memberships.actorId);
          assert.ok(target);
          assert.equal((await admin.post(`/api/choirs/${fixture.choirId}/memberships/${target.id}`, { data: { action: "remove", expectedRevision: target.revision } })).status(), 204);
        } finally { await admin.dispose(); }
        await offline.reload();
        await offline.getByRole("heading", { name: "本机保留的乐谱", exact: true }).waitFor();
        await offline.getByText("已无法访问此云盘，以下为本机保留内容", { exact: true }).waitFor();
        await offline.getByRole("link", { name: new RegExp(fixture.fileName.replace(/\.pdf$/i, "")) }).waitFor();
        await offline.getByRole("link", { name: new RegExp(fixture.fileName.replace(/\.pdf$/i, "")) }).click();
        await expectSampleScoreContent(offline);
      });
    });
  });
}
