import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";
let server;
before(async () => { server = await startVisualServer({ script: "dev" }); });
after(async () => server?.stop());

for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: shared navigation preserves pan and cancellation in both layouts and input modes`, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    for (const layout of ["page", "continuous"]) for (const editing of [false, true]) for (const zoom of [1, 2]) {
      t.diagnostic(`${layout}, editing=${editing}, zoom=${zoom}`);
      const context = await browser.newContext({ viewport: { width: 834, height: 800 }, hasTouch: true,
        serviceWorkers: "block", reducedMotion: "no-preference" });
      await context.route("**/api/**", async route => route.fulfill(resolveFixtureRequest({
        pathname: new URL(route.request().url()).pathname, method: route.request().method(),
        identity: "member", scenarioId: "reader-controls-narrow", cookie: "" })));
      await context.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
      const page = await context.newPage();
      await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`);
      await page.locator("[data-page-turn-current] [data-pdf-canvas-active]").waitFor();
      await page.locator(".page-reader__viewport").click({ position: { x: 417, y: 400 } });
      if (layout === "continuous") {
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("button", { name: "连续滚动", exact: true }).click();
      }
      if (editing) await page.getByRole("button", { name: "编辑", exact: true }).click();
      const viewport = page.locator(layout === "page" ? ".page-reader__viewport" : ".continuous-reader");
      const touch = layout === "continuous" && !editing;
      const fingers = editing ? 2 : 1;
      if (zoom === 2) {
        await send(viewport, touch, "down", [200, 300]);
        await send(viewport, touch, "move", [200, 400]);
        await send(viewport, touch, "up", [200, 400]);
        await expect(viewport).toHaveAttribute("data-zoom", "2");
      }
      if (touch) assert.equal(await viewport.evaluate(node => getComputedStyle(node).touchAction), "pan-y");
      const allowance = await viewport.evaluate(node => Math.max(0,
        node.querySelector(".page-reader__content, .continuous-reader__inner").getBoundingClientRect().right - node.getBoundingClientRect().right));
      const xs = offset => Array.from({ length: fingers }, (_, index) => 500 + index * 100 - offset);
      await send(viewport, touch, "down", xs(0));
      if (allowance > 0) {
        await send(viewport, touch, "move", xs(allowance));
        assert.equal(await currentPage(viewport), 1);
      }
      await send(viewport, touch, "move", xs(allowance + 100));
      const surface = viewport.locator('[data-page-turn-phase="dragging"]').first();
      await expect(surface).toHaveAttribute("data-page-turn-progress", /-0\./);
      await viewport.locator("[data-page-turn-target] [data-pdf-canvas-active]").waitFor();
      await send(viewport, touch, "move", xs(allowance + 105));
      const directory = "artifacts/verification/302";
      await mkdir(directory, { recursive: true });
      if (editing && zoom === 2) await page.screenshot({ path: `${directory}/${name}-${layout}-drag.png` });
      // A slow partial turn returns without fitting the current page.
      await page.waitForTimeout(150);
      await send(viewport, touch, "up", xs(allowance + 105));
      await expect(viewport.locator('[data-page-turn-phase="settling"]')).toHaveCount(0);
      assert.equal(await currentPage(viewport), 1);
      assert.equal(Number(await viewport.getAttribute("data-zoom")), zoom);
      // Consume the current pan allowance, then the common distance rule commits either input.
      const nextAllowance = await viewport.evaluate(node => Math.max(0, node.querySelector(".page-reader__content, .continuous-reader__inner").getBoundingClientRect().right - node.getBoundingClientRect().right));
      await send(viewport, touch, "down", xs(0));
      await send(viewport, touch, "move", xs(nextAllowance + 300));
      await send(viewport, touch, "up", xs(nextAllowance + 300));
      await expect.poll(() => currentPage(viewport)).toBe(2);
      await expect.poll(async () => Number(await viewport.getAttribute("data-zoom"))).toBeLessThanOrEqual(1);
      assert.equal(await viewport.locator('[data-edit-page-turn]').count(), 0);
      if (editing) await expect(viewport.locator('.annotation-overlay[data-editing]')).toHaveAttribute("data-tool", "text");
      if (editing && zoom === 2) await page.screenshot({ path: `${directory}/${name}-${layout}-complete.png` });
      await context.close();
    }
  });
}
async function currentPage(viewport) {
  return viewport.evaluate(node => {
    const current = node.querySelector("[data-page-turn-current]");
    return Number(current.dataset.pageNumber ?? Number(current.dataset.index) + 1);
  });
}
async function send(viewport, touch, phase, xs) {
  await viewport.evaluate((node, { touch, phase, xs }) => {
    if (touch) {
      const samples = xs.map((clientX, identifier) => new Touch({ identifier: identifier + 1, target: node, clientX, clientY: 300 }));
      node.dispatchEvent(new TouchEvent(`touch${{ down: "start", move: "move", up: "end" }[phase]}`,
        { bubbles: true, cancelable: true, changedTouches: samples, touches: phase === "up" ? [] : samples, targetTouches: phase === "up" ? [] : samples }));
    } else xs.forEach((clientX, index) => node.dispatchEvent(new PointerEvent(`pointer${phase}`,
      { bubbles: true, pointerType: "touch", pointerId: index + 1, clientX, clientY: 300 })));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { touch, phase, xs });
}

test("Chromium native touch keeps vertical momentum and reserves horizontal navigation", async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 834, height: 800 }, hasTouch: true,
    isMobile: true, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.route("**/api/**", async route => route.fulfill(resolveFixtureRequest({
    pathname: new URL(route.request().url()).pathname, method: route.request().method(),
    identity: "member", scenarioId: "reader-controls-narrow", cookie: "" })));
  await context.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
  const page = await context.newPage();
  await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`);
  await page.locator("[data-page-turn-current] [data-pdf-canvas-active]").waitFor();
  await page.locator(".page-reader__viewport").click({ position: { x: 417, y: 400 } });
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "连续滚动", exact: true }).click();
  const viewport = page.locator(".continuous-reader");
  await viewport.evaluate(node => {
    node.touchDecisions = [];
    document.addEventListener("touchmove", event => node.touchDecisions.push(event.defaultPrevented));
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 400, y: 650 }] });
  for (const y of [610, 560, 500, 430, 350]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 400, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const releasedTop = await viewport.evaluate(node => node.scrollTop);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(releasedTop + 10);
  assert.ok((await viewport.evaluate(node => node.touchDecisions)).every(value => !value));
  await page.waitForTimeout(500);
  await viewport.evaluate(node => { node.scrollTop = 0; node.touchDecisions = []; });
  await expect.poll(() => currentPage(viewport)).toBe(1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 650, y: 400 }] });
  for (const x of [610, 550, 480, 400, 300]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 400 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => currentPage(viewport)).toBe(2);
  assert.ok((await viewport.evaluate(node => node.touchDecisions)).some(Boolean));
});
