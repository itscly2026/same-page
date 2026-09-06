import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";
import { startNativeRenderer } from "./native-renderer.mjs";

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${engineName}: native conversion, image reading and verified offline reopen`, { timeout: 180_000 }, async t => {
    const native = await startNativeRenderer(); t.after(() => native.stop());
    const fixture = await startStorageFixture({ authenticated: true, rendererOrigin: native.origin }); t.after(() => fixture.stop());
    const profile = await mkdtemp(path.join(tmpdir(), "same-page-images-"));
    t.after(() => rm(profile, { recursive: true, force: true }));
    let context = await engine.launchPersistentContext(profile, { headless: true, serviceWorkers: "allow", viewport: { width: 1024, height: 768 } });
    t.after(() => context.close());
    const account = fixture.accounts[1];
    assert.equal((await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, {
      headers: { origin: fixture.origin }, data: { email: account.email, password: account.password },
    })).status(), 200);
    let page = await context.newPage();
    const base = `${fixture.origin}/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/versions/${fixture.versionId}/images`;
    await page.goto(fixture.origin);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.goto(`${fixture.origin}/choirs/${fixture.choirId}/scores/${fixture.scoreId}`);
    await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
    await page.locator(".page-reader__viewport").click({ position: { x: 510, y: 300 } });
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "图片兼容模式", exact: true }).click();
    let conversion;
    await expect.poll(async () => {
      conversion = await (await context.request.get(base)).json();
      return conversion.state === "ready" || conversion.state === "failed";
    }, { timeout: 90_000 }).toBe(true);
    const failures = [...fixture.logs.join("").matchAll(/\{"event":"score_image_conversion_failed","stage":"[a-z-]+","reason":"[a-z-]+"\}/g)].map(match => JSON.parse(match[0]));
    assert.equal(conversion.state, "ready", JSON.stringify({ failure: conversion.failure, phases: failures }));
    const manifest = conversion.manifest;
    // Backend readiness can precede the browser's next manifest poll. Wait for
    // preparation and painting; an existing canvas may still be the old PDF.
    await expect(page.locator(".reader-display-notice")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator(".reader-display-recovery")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "图片兼容模式", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
    if (!await page.getByRole("button", { name: "更多", exact: true }).isVisible()) await page.locator(".page-reader__viewport").click({ position: { x: 510, y: 300 } });
    if (!await page.getByRole("dialog", { name: "更多阅读选项" }).isVisible()) await page.getByRole("button", { name: "更多", exact: true }).click();
    // Image-mode preparation now automatically saves its verified offline copy.
    await expect(page.getByRole("status").filter({ hasText: "离线副本已完整校验" })).toBeVisible({ timeout: 30_000 });
    await mkdir("artifacts/verification/137", { recursive: true });
    await page.screenshot({ path: `artifacts/verification/137/${engineName}-images.png` });
    await page.setViewportSize({ width: 320, height: 568 });
    const menu = page.getByRole("dialog", { name: "更多阅读选项" });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    await page.screenshot({ path: `artifacts/verification/137/${engineName}-images-narrow.png` });
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 568, `reading options must stay inside the narrow viewport: ${JSON.stringify(bounds)}`);
    await page.setViewportSize({ width: 1024, height: 768 });
    const readerUrl = page.url();
    if (engineName === "webkit") await fixture.stop();
    await context.close();
    context = await engine.launchPersistentContext(profile, { headless: true, serviceWorkers: "allow", viewport: { width: 1024, height: 768 } });
    if (engineName === "chromium") await context.setOffline(true);
    page = await context.newPage();
    const resources = [];
    page.on("request", request => resources.push(request.url()));
    await page.goto(readerUrl, { waitUntil: "domcontentloaded" });
    await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('.page-reader__sheet[data-page-turn-current]')).toHaveAttribute("data-page-number", "2");
    await page.locator(".page-reader__viewport").click({ position: { x: 510, y: 300 } });
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "PDF 阅读", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "本机没有PDF离线副本" }).first()).toBeVisible();
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("button", { name: "文本", exact: true }).click();
    await page.locator(".annotation-overlay svg").evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const init = { bubbles: true, pointerId: 1, pointerType: "touch", clientX: bounds.left + bounds.width * .35, clientY: bounds.top + bounds.height * .4 };
      element.dispatchEvent(new PointerEvent("pointerdown", init)); element.dispatchEvent(new PointerEvent("pointerup", init));
    });
    await page.getByRole("textbox", { name: "批注文本", exact: true }).fill("图片离线批注");
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByText("图片离线批注", { exact: true })).toBeVisible();
    assert.equal(resources.some(url => /\/assets\/pdf-[A-Za-z0-9_-]{8}\.js/.test(url)), false, "image reopen must not load the PDF.js module");
    if (engineName === "chromium") {
      await context.setOffline(false);
      await page.getByRole("button", { name: "更多", exact: true }).click();
      await page.getByRole("button", { name: "立即同步", exact: true }).click();
      const annotations = `${fixture.origin}/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations`;
      await expect.poll(async () => (await (await context.request.get(annotations)).json()).objects.some(o => o.payload?.text === "图片离线批注")).toBe(true);
      await page.getByRole("button", { name: "PDF 阅读", exact: true }).click();
      await expect(page.locator('.page-reader__sheet[data-page-turn-current]')).toHaveAttribute("data-page-number", "2");
      await expect(page.getByText("图片离线批注", { exact: true })).toBeVisible();
    }
    await writeFile(`artifacts/verification/137/${engineName}-images.json`, JSON.stringify({ engine: manifest.engine, pages: manifest.pages.length, sizes: manifest.pages.map(p => p.assets), backend: "local PDFium + Worker/D1/R2 + IndexedDB", cloudContainer: false }, null, 2));
  });
}
