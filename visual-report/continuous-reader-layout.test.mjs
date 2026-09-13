import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

let server;
before(async () => { server = await startVisualServer({ script: "dev", cwd: process.env.CONTINUOUS_LAYOUT_CWD ?? process.cwd() }); });
after(async () => { await server?.stop(); });

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: continuous fit, editing and a preferences return preserve the reading position`, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 834, height: 700 },
      colorScheme: "light", locale: "zh-CN", reducedMotion: "reduce", serviceWorkers: "block" });
    await context.route("**/api/**", async route => {
      const request = route.request();
      await route.fulfill(resolveFixtureRequest({ pathname: new URL(request.url()).pathname,
        method: request.method(), identity: "member", scenarioId: "reader-controls-narrow", cookie: "" }));
    });
    await context.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
    const page = await context.newPage();
    await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`);
    const paged = page.locator(".page-reader__viewport");
    await page.locator("[data-page-turn-current] [data-pdf-canvas-active]").waitFor();
    await paged.click({ position: { x: 417, y: 350 } });
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "连续滚动", exact: true }).click();
    const reader = page.locator(".continuous-reader");
    await expect(reader).toHaveAttribute("data-zoom", "1");
    await reader.locator("[data-pdf-canvas-active]").first().waitFor();
    await reader.evaluate(element => { element.scrollTop = 300; });
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(300);
    const directory = `artifacts/verification/continuous-layout/${process.env.CONTINUOUS_LAYOUT_LABEL ?? "after"}`;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: `${directory}/${name}-reading.png` });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator(".annotation-controls").waitFor();
    await expect(reader.locator(".annotated-pdf-page:visible")).toHaveCount(1);
    assert.equal(await reader.evaluate(element => element.scrollTop), 300);
    await page.screenshot({ path: `${directory}/${name}-editing.png` });
    await page.getByRole("button", { name: "完成编辑", exact: true }).click();
    await page.getByRole("button", { name: "笔记图层", exact: true }).click();
    await page.getByRole("link", { name: "设置此云盘的默认显示" }).click();
    await page.waitForURL("**/preferences");
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await reader.waitFor();
    await expect.poll(() => reader.evaluate(element => element.scrollTop)).toBe(300);
    await page.getByRole("button", { name: "关闭笔记显示", exact: true }).click();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "适合页面", exact: true }).click();
    await expect.poll(() => reader.evaluate(element => Number(element.dataset.zoom))).toBeLessThan(1);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.screenshot({ path: `${directory}/${name}-fit.png` });
  });
}
