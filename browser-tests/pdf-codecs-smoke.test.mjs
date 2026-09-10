import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: legacy fills missing APIs in page and Worker and paints CCITT/JPEG2000 online and offline`, { timeout: 90000 }, async t => {
    const pdf = await readFile(new URL("./fixtures/image-codecs.pdf", import.meta.url));
    const fixture = await startStorageFixture({ authenticated: true, pdf });
    t.after(() => fixture.stop());
    const profile = await mkdtemp(path.join(tmpdir(), "same-page-pdf-codecs-"));
    const context = await engine.launchPersistentContext(profile, { headless: true, serviceWorkers: "allow" });
    t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
    const account = fixture.accounts[0];
    assert.equal((await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, {
      headers: { origin: fixture.origin }, data: { email: account.email, password: account.password },
    })).status(), 200);
    await context.addInitScript(installCompatibilityProbe);
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/choirs/${fixture.choirId}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.locator(".file-row__open").click();
    await page.waitForURL(`**/scores/${fixture.scoreId}*`);
    const scoreUrl = page.url();
    await assertSquare(page, 1);
    const probe = await page.evaluate(() => globalThis.__pdfCompatibilityProbe);
    assert.deepEqual(probe.pageMissing, [true, true, true, true]);
    assert.deepEqual(probe.workerMissing, [true, true, true, true]);
    assert.deepEqual(probe.workerRestored, [true, true, true, true]);
    assert.deepEqual(await page.evaluate(() => [typeof Iterator, typeof Promise.try,
      typeof Map.prototype.getOrInsert, typeof Map.prototype.getOrInsertComputed]), Array(4).fill("function"));
    await page.getByRole("button", { name: "下一页", exact: true }).press("Enter");
    await assertSquare(page, 2);
    if (!await page.getByRole("button", { name: "更多", exact: true }).isVisible()) {
      const viewport = page.locator(".page-reader__viewport");
      const bounds = await viewport.boundingBox();
      await viewport.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    }
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await expect(page.getByRole("region", { name: "本机离线副本", exact: true }).getByRole("status")).toHaveText("可离线使用", { timeout: 30_000 });
    await page.goto(`${fixture.origin}/choirs/${fixture.choirId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /^离线副本：/ }).click();
    await page.getByRole("status").filter({ hasText: /^可离线使用$/ }).waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await fixture.stop();
    // WebKit's emulated offline navigation can fail before its Service Worker
    // runs. Stop the actual origin for both engines; Chromium also uses the
    // browser offline flag. No API or asset responses are mocked.
    if (engine === chromium) await context.setOffline(true);
    await page.goto(scoreUrl, { waitUntil: "domcontentloaded" });
    assert.equal(await page.evaluate(async () => {
      try { await fetch("/api/health"); return false; } catch { return true; }
    }), true, "the origin must be unreachable");
    const currentSheet = page.locator(".page-reader__sheet[data-page-turn-current]");
    await expect(currentSheet).toBeVisible();
    const restoredPage = Number(await currentSheet.getAttribute("data-page-number"));
    assert.ok(restoredPage === 1 || restoredPage === 2);
    await assertSquare(page, restoredPage);
    await page.getByRole("button", { name: restoredPage === 1 ? "下一页" : "上一页", exact: true }).press("Enter");
    await assertSquare(page, restoredPage === 1 ? 2 : 1);
    // An unsupported engine must not strand an already downloaded PDF offline.
    await context.addInitScript(() => { Promise.withResolvers = undefined; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("alert")).toContainText("请升级浏览器或系统");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "下载原 PDF", exact: true }).click()]);
    assert.deepEqual(await readFile(await download.path()), pdf);
  });
}

test("missing native Promise.withResolvers exposes engine recovery and an independent PDF download", { timeout: 60000 }, async t => {
  const fixture = await startStorageFixture({ authenticated: true });
  t.after(() => fixture.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const account = fixture.accounts[0];
  assert.equal((await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, {
    headers: { origin: fixture.origin }, data: { email: account.email, password: account.password },
  })).status(), 200);
  await context.addInitScript(() => { Promise.withResolvers = undefined; });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/choirs/${fixture.choirId}/scores/${fixture.scoreId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("alert")).toContainText("请升级浏览器或系统");
  const link = page.getByRole("link", { name: "下载原 PDF", exact: true });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const bytes = await readFile(await download.path());
  assert.deepEqual(bytes, fixture.pdf);
});

async function assertSquare(page, pageNumber) {
  const canvas = page.locator(`.page-reader__sheet[data-page-turn-current][data-page-number="${pageNumber}"] .pdf-page-canvas canvas[data-pdf-canvas-active]`).first();
  await expect(canvas).toBeVisible();
  // A successful render promise / visible canvas is insufficient: missing
  // codecs silently finish with a white bitmap. The fixture has a black
  // center and a white corner, so assert actual decoded image content.
  const pixels = await canvas.evaluate(canvas => {
    const ctx = canvas.getContext("2d");
    return { center: [...ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data],
      corner: [...ctx.getImageData(canvas.width / 8, canvas.height / 8, 1, 1).data] };
  });
  assert.ok(pixels.center.slice(0, 3).every(value => value < 30), `page ${pageNumber}: expected black center, got ${pixels.center}`);
  assert.ok(pixels.corner.slice(0, 3).every(value => value > 225), `page ${pageNumber}: expected white corner, got ${pixels.corner}`);
}

// This is a controlled API-absence regression, not a claim to emulate old Safari.
// Use the shipped entry/Worker and real pixels; both realms must restore APIs.
function installCompatibilityProbe() {
  const removeApis = () => {
    globalThis.Iterator = undefined;
    Promise.try = undefined;
    Map.prototype.getOrInsert = undefined;
    Map.prototype.getOrInsertComputed = undefined;
    return [globalThis.Iterator, Promise.try, Map.prototype.getOrInsert,
      Map.prototype.getOrInsertComputed].map(value => value === undefined);
  };
  const pageMissing = removeApis();
  globalThis.__pdfCompatibilityProbe = { pageMissing };
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      const source = `const missing = (${removeApis.toString()})();
        await import(${JSON.stringify(new URL(String(url), location.href).href)});
        self.postMessage({ compatibilityProbe: true, missing, restored:
          [globalThis.Iterator, Promise.try, Map.prototype.getOrInsert,
           Map.prototype.getOrInsertComputed].map(value => typeof value === "function") });`;
      const wrapper = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      super(wrapper, options);
      this.addEventListener("message", event => {
        if (!event.data?.compatibilityProbe) return;
        globalThis.__pdfCompatibilityProbe.workerMissing = event.data.missing;
        globalThis.__pdfCompatibilityProbe.workerRestored = event.data.restored;
        URL.revokeObjectURL(wrapper);
      });
    }
  };
}
