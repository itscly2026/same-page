import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

// Real client, IndexedDB, PDF canvas and outbox; API fixtures and network events
// are simulated. This is not physical-device or airplane-mode acceptance.
test("reader menu, durable offline draft, reconnect and recovery evidence", async (t) => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const output = "artifacts/verification/issue-142";
  await mkdir(output, { recursive: true });
  const evidence = [];
  for (const width of [390, 834]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    await context.addInitScript(() => {
      localStorage.setItem("reader-gesture-hint-seen", "true");
      window.fixtureOnline = true;
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (window.fixtureStorageFailed && this.name === "annotations") throw new DOMException("full", "QuotaExceededError");
        return originalPut.apply(this, args);
      };
      Object.defineProperty(navigator, "onLine", { get: () => window.fixtureOnline });
    });
    let pushes = 0;
    let failSync = false;
    await context.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/annotations/push")) {
        pushes++;
        if (failSync) return route.fulfill({ status: 503, body: "unavailable" });
        const { operations } = request.postDataJSON();
        return route.fulfill({ json: { results: operations.map(op => ({ opId: op.opId, status: "accepted", object: {
          id: op.annotationId, layerId: op.layerId, version: op.baseVersion + 1, deleted: op.type === "delete", payload: op.payload,
          createdByDisplayName: "周宁", updatedByDisplayName: "周宁", updatedAt: Date.now(),
        } })) } });
      }
      await route.fulfill(resolveFixtureRequest({ pathname, method: request.method(), identity: "member", scenarioId: "reader-status", cookie: "" }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${app.origin}/choirs/visual-choir`);
    await page.getByRole("link", { name: /排练示例 · 秋日合唱/ }).click();
    await page.locator("[data-page-turn-current] [data-pdf-canvas-active]").waitFor();
    const stage = page.locator(".page-reader__viewport");
    const box = await stage.boundingBox();
    await stage.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.getByRole("button", { name: "更多", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "更多阅读选项" });
    await menu.waitFor();
    assert.match(await menu.innerText(), /保存与同步/);
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 901);
    await page.screenshot({ path: `${output}/${width}-menu.png` });
    await page.getByRole("button", { name: "关闭更多阅读选项" }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator(".annotation-controls").waitFor();
    await page.screenshot({ path: `${output}/${width}-editing.png` });
    await page.evaluate(() => { window.fixtureOnline = false; window.dispatchEvent(new Event("offline")); });
    const svg = page.locator("[data-page-turn-current] .annotation-overlay svg");
    await svg.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: width / 2, clientY: 450, bubbles: true });
    await svg.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", clientX: width / 2, clientY: 450, bubbles: true });
    await page.getByRole("textbox", { name: "批注文本" }).fill("本机草稿等待重连");
    assert.equal(await page.locator(".annotation-controls").count(), 0);
    await page.evaluate(() => history.back());
    await page.getByRole("dialog", { name: "请先完成编辑" }).waitFor();
    await page.getByRole("button", { name: "返回编辑器" }).click();
    await page.getByRole("dialog", { name: "请先完成编辑" }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("textbox", { name: "批注文本" }).inputValue(), "本机草稿等待重连");
    await page.screenshot({ path: `${output}/${width}-text.png` });
    await page.evaluate(() => { window.fixtureStorageFailed = true; });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByText("本机保存失败", { exact: true }).waitFor();
    await page.evaluate(() => history.back());
    await page.getByRole("dialog", { name: "请先完成编辑" }).waitFor();
    await page.getByRole("button", { name: "返回编辑器" }).click();
    await page.getByRole("dialog", { name: "请先完成编辑" }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("textbox", { name: "批注文本" }).inputValue(), "本机草稿等待重连");
    await page.screenshot({ path: `${output}/${width}-storage-failed.png` });
    await page.evaluate(() => { window.fixtureStorageFailed = false; });
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("form", { name: "文字输入" }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByText("已保存在本机 · 等待联网", { exact: true }).waitFor();
    assert.equal(pushes, 0);
    await page.getByText("已保存在本机 · 等待联网", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${width}-offline-draft.png` });
    failSync = true;
    await page.evaluate(() => { window.fixtureOnline = true; });
    await menu.getByRole("button", { name: "立即同步", exact: true }).click();
    await menu.getByRole("button", { name: "重试同步", exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${width}-sync-failed.png` });
    failSync = false;
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); });
    await page.getByText("已同步", { exact: true }).waitFor();
    assert.ok(pushes > 0);
    await page.screenshot({ path: `${output}/${width}-synced.png` });
    // The blocked service worker makes automatic offline preparation fail.
    // Retry that failure; PDF bytes can now be reused without another request.
    await page.getByRole("button", { name: "重试下载离线副本", exact: true }).click();
    await page.getByText("离线下载未完成，仍可在线阅读，现有离线版本没有切换。请重试。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "重试下载离线副本" }).waitFor();
    await page.getByRole("button", { name: "重试下载离线副本" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${width}-download-failed.png` });
    await page.getByRole("button", { name: "图片兼容模式", exact: true }).click();
    await page.getByText(/显示切换未完成，已保留原谱面/).first().waitFor();
    await page.getByRole("button", { name: "关闭更多阅读选项" }).click();
    await page.screenshot({ path: `${output}/${width}-display-failed.png` });
    assert.equal(await page.locator("[data-page-turn-current] [data-pdf-canvas-active]").count(), 1);
    assert.deepEqual(errors, []);
    evidence.push({ width, height: 900, pushes, errors, flow: "open → edit → durable local draft → simulated reconnect → accepted sync → download failure → display rollback" });
    await context.close();
  }
  const loadingContext = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: "block" });
  let failOpen;
  const delayedPdf = new Promise(resolve => { failOpen = resolve; });
  await loadingContext.route("**/api/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/pdf")) {
      await delayedPdf;
      return route.fulfill({ status: 503, body: "unavailable" });
    }
    return route.fulfill(resolveFixtureRequest({ pathname, method: request.method(), identity: "member", scenarioId: "reader-status", cookie: "" }));
  });
  const loadingPage = await loadingContext.newPage();
  await loadingPage.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`, { waitUntil: "domcontentloaded" });
  await loadingPage.locator(".reader-loading").waitFor();
  await loadingPage.screenshot({ path: `${output}/390-loading.png` });
  failOpen();
  await loadingPage.getByRole("heading", { name: "无法打开", exact: true }).waitFor();
  await loadingPage.screenshot({ path: `${output}/390-open-failed.png` });
  assert.ok(await loadingPage.getByRole("link", { name: "返回云盘", exact: true }).isVisible());
  assert.ok(await loadingPage.getByRole("button", { name: "重试加载", exact: true }).isVisible());
  await loadingContext.close();
  await writeFile(`${output}/evidence.json`, JSON.stringify({ environment: "Chromium; simulated API and offline events; no real-device claim", evidence }, null, 2));
});
