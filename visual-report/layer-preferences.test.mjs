import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const drive = "/choirs/visual-choir";
let server;
let origin = process.env.LAYOUT_TEST_ORIGIN;
before(async () => {
  if (!origin) { server = await startVisualServer({ script: "dev", cwd: root }); origin = server.origin; }
});
after(async () => { await server?.stop(); });

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: reading preferences, colors and expanded layer panels remain usable`, async (t) => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "reduce", locale: "zh-CN" });
    const fixture = createVisualFixtureSession();
    const writes = [];
    let failNext = false;
    let identity = "member";
    await context.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const method = request.method();
      const body = request.postDataJSON();
      if (method === "PUT") {
        writes.push({ pathname, body, failed: failNext });
        if (failNext) { failNext = false; return route.fulfill({ status: 503, body: "{}", contentType: "application/json" }); }
      }
      const response = fixture.resolve({ pathname, method, body, identity, cookie: request.headers().cookie ?? "" });
      if (pathname.endsWith("/layers")) {
        const payload = JSON.parse(response.body);
        // Member fixture has a drive-wide E edit grant and no grants on S/A/T/B.
        payload.layers = payload.layers.map(layer => layer.sharedSlot === "E" ? { ...layer, canEdit: true } : layer);
        response.body = JSON.stringify(payload);
      }
      await route.fulfill(response);
    });
    await context.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
    const page = await context.newPage();
    // Each geometry is exercised once; both engines run the behavior flow below.
    const viewports = engineName === "chromium"
      ? [[320, 740], [740, 320], [1440, 1000]]
      : [[834, 1194], [1194, 834]];
    const geometry = async (selector, name, sizes = viewports) => {
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        // Reader width follows ResizeObserver; wait for the resized sheet before
        // measuring controls rather than reading the previous viewport's bitmap.
        await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
        await layout(page, selector);
        await capture(page, `${engineName}-${width}-${name}`);
      }
    };

    await page.goto(`${origin}${drive}/preferences`);
    const checkbox = page.getByRole("checkbox", { name: "E · 全体 默认显示" });
    await checkbox.waitFor();
    assert.equal(await page.locator('input[type="color"]').count(), 0);
    await geometry(".preference-display-toggle", "preferences");
    await page.getByRole("link", { name: "批注颜色", exact: true }).click();
    await page.getByRole("heading", { name: "批注颜色", exact: true }).waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 0);
    await geometry(".settings-color-control input", "colors");
    await page.getByRole("link", { name: "返回阅读偏好" }).click();
    await page.goto(`${origin}${drive}/scores/visual-score`);
    await showReader(page);
    await page.getByRole("button", { name: "看哪些批注", exact: true }).click();
    await page.getByRole("checkbox", { name: "显示 E · 全体" }).waitFor();
    assert.equal(await page.getByRole("checkbox").count(), 5);
    await page.locator(".layer-section--personal").scrollIntoViewIfNeeded();
    await geometry(".reader-layer-toggle", "display");
    await page.getByRole("button", { name: "关闭批注显示" }).click();
    await page.getByRole("button", { name: /^(编辑|完成编辑)$/, exact: true }).click();
    await page.getByRole("button", { name: /当前编辑层/ }).click();
    await page.getByRole("dialog", { name: "写到哪里" }).waitFor();
    await page.getByRole("button", { name: "P，我的笔记", exact: true }).scrollIntoViewIfNeeded();
    await geometry(".annotation-layer-slot", "target");
    await page.getByRole("button", { name: "关闭写入目标" }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}${drive}/preferences`);
    const display = page.getByRole("checkbox", { name: "E · 全体 默认显示" });
    await display.waitFor();
    failNext = true;
    await display.press("Space");
    await page.getByRole("alert").waitFor();
    assert.equal(await display.isChecked(), true);
    await capture(page, `${engineName}-display-save-failure`);
    await page.getByRole("button", { name: "重试 E · 全体" }).click();
    await page.waitForFunction(() => !document.querySelector('input[aria-label="E · 全体 默认显示"]').checked);
    await page.getByRole("link", { name: "批注颜色", exact: true }).click();
    const color = page.getByLabel("E · 全体 批注颜色", { exact: true });
    const previousColor = await color.inputValue();
    failNext = true;
    await color.fill("#123456");
    await page.getByRole("alert").waitFor();
    assert.equal(await color.inputValue(), previousColor);
    await capture(page, `${engineName}-color-save-failure`);
    await page.getByRole("button", { name: "重试 E · 全体" }).click();
    await page.waitForFunction(() => document.querySelector('input[type="color"]').value === "#123456");
    await capture(page, `${engineName}-color-custom`);
    await page.getByRole("button", { name: "E · 全体 恢复默认颜色" }).click();
    await page.getByRole("button", { name: "E · 全体 恢复默认颜色" }).waitFor({ state: "hidden" });
    await page.reload();
    assert.notEqual(await page.getByLabel("E · 全体 批注颜色", { exact: true }).inputValue(), "#123456");

    await page.goto(`${origin}${drive}/scores/visual-score`);
    await showReader(page);
    await page.getByRole("button", { name: "看哪些批注", exact: true }).click();
    const scoreDisplay = page.getByRole("checkbox", { name: "显示 E · 全体" });
    await scoreDisplay.waitFor();
    assert.equal(await scoreDisplay.isChecked(), false, "drive default applies to this score");
    // Clear the pre-existing Bass fixture override first.
    await page.getByRole("button", { name: "使用云盘默认", exact: true }).click();
    await page.getByRole("button", { name: "使用云盘默认", exact: true }).waitFor({ state: "hidden" });
    failNext = true;
    await page.locator(".reader-layer-toggle").filter({ has: scoreDisplay }).locator(".layer-card__identity").click();
    await page.getByRole("alert").waitFor();
    assert.equal(await scoreDisplay.isChecked(), false);
    await page.getByRole("button", { name: "重试未保存项" }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="显示 E · 全体"]').checked);
    await capture(page, `${engineName}-score-override`);
    await page.getByRole("button", { name: "使用云盘默认", exact: true }).click();
    await page.getByRole("button", { name: "使用云盘默认", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await scoreDisplay.isChecked(), false);
    await page.getByRole("button", { name: "关闭批注显示" }).click();
    assert.equal(await page.getByText("第一排男高音这里请统一提前吸气并保持轻声进入", { exact: true }).count(), 0);
    assert.equal(await page.getByText("换气", { exact: true }).count(), 1, "Personal remains visible in reading");
    const beforeEditing = writes.length;
    await page.getByRole("button", { name: /^(编辑|完成编辑)$/, exact: true }).click();
    await page.getByRole("button", { name: /当前编辑层/ }).click();
    await page.getByRole("button", { name: "S，女高音，只读，查看权限说明" }).click();
    await page.getByRole("dialog", { name: "仅可查看" }).waitFor();
    await capture(page, `${engineName}-permission`);
    await page.getByRole("button", { name: "知道了" }).click();
    await page.getByRole("button", { name: "E，全体", exact: true }).click();
    await page.getByText("第一排男高音这里请统一提前吸气并保持轻声进入", { exact: true }).waitFor();
    assert.equal(await page.getByText("换气", { exact: true }).count(), 0, "editing shows only the selected shared layer");
    assert.equal(await page.getByRole("button", { name: "页面位置" }).isDisabled(), true);
    await capture(page, `${engineName}-edit-hidden-layer`);
    await page.getByRole("button", { name: /^(编辑|完成编辑)$/, exact: true }).click();
    await page.getByText("第一排男高音这里请统一提前吸气并保持轻声进入", { exact: true }).waitFor({ state: "hidden" });
    await page.getByText("换气", { exact: true }).waitFor();
    assert.equal(writes.length, beforeEditing, "editing never writes a subscription");

    identity = "admin";
    await page.goto(`${origin}${drive}/shared-layers`);
    await page.getByRole("link", { name: /E · 全体.*已授权/ }).waitFor();
    const managementSizes = viewports.filter(([, height]) => height > 320);
    await geometry(".settings-layer-link, .layer-create-form input[type=text]", "management", managementSizes);
    await page.getByRole("link", { name: /E · 全体.*已授权/ }).click();
    await page.getByRole("heading", { name: "E · 全体" }).waitFor();
    await geometry(".settings-member-row, .layer-details-form input[type=text]", "grants", managementSizes);
    if (process.env.LAYOUT_CAPTURE_DIR) await writeFile(path.join(process.env.LAYOUT_CAPTURE_DIR, `${engineName}-interactions.json`), JSON.stringify({ writes, checks: ["drive defaults", "score override and restore", "save failure and retry", "custom color and restore", "permission explanation", "edit hidden layer without subscribing", "exit restores reading"] }, null, 2));
    await context.close();
  });
}

async function showReader(page) {
  await page.waitForFunction(() => document.querySelector("[data-pdf-canvas-active]")?.width > 100);
  const viewport = page.locator(".page-reader__viewport");
  const box = await viewport.boundingBox();
  await viewport.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.getByRole("button", { name: "看哪些批注", exact: true }).waitFor();
}
async function layout(page, selector) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "document has no horizontal overflow");
  const controls = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { width: box.width, height: box.height, left: box.left, right: box.right };
  }));
  assert.ok(controls.length > 0);
  for (const box of controls) assert.ok(box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= (await page.viewportSize()).width, JSON.stringify(box));
}
async function capture(page, name) {
  if (!process.env.LAYOUT_CAPTURE_DIR) return;
  await mkdir(process.env.LAYOUT_CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.LAYOUT_CAPTURE_DIR, `${name}.png`), fullPage: true });
}
