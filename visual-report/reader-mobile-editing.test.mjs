import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";

import { startViteServer } from "../scripts/vite-server.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.READER_MOBILE_TEST_PORT ?? 4187);
let appServer;
let appOrigin = process.env.LAYOUT_TEST_ORIGIN;

before(async () => {
  if (!appOrigin) {
    appServer = await startViteServer({ script: "dev", port, cwd: repositoryRoot });
    appOrigin = appServer.origin;
  }
});

after(async () => {
  await appServer?.stop();
});

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
test(`${engineName}: keeps the capsule at the right edge above its page hint in reading and editing`, async (context) => {
  const browser = await engine.launch({ headless: true });
  context.after(() => browser.close());

  for (const width of [320, 360, 390, 412, 768, 834, 1024, 1194]) {
    const page = await openMemberReader(browser, { width, height: 800 });
    await showReaderChrome(page);

    const result = await page.evaluate(() => {
      const actions = document.querySelector(".reader-chrome__actions");
      const pageHint = document.querySelector(".reader-page-indicator");
      if (!(actions instanceof HTMLElement) || !(pageHint instanceof HTMLElement)) {
        throw new Error("reader controls missing");
      }
      const actionBox = actions.getBoundingClientRect();
      const pageBox = pageHint.getBoundingClientRect();
      return {
        labels: [...actions.querySelectorAll("button")].map((button) => button.ariaLabel),
        states: [...actions.querySelectorAll("button")].map((button) => button.dataset.state),
        sizes: [...actions.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        actionLeft: actionBox.left,
        actionRight: actionBox.right,
        pageBelowActions: pageBox.top >= actionBox.bottom,
        centerDelta: Math.abs(
          (pageBox.left + pageBox.right) / 2 - (actionBox.left + actionBox.right) / 2,
        ),
      };
    });

    assert.deepEqual(result.labels, ["编辑", "图层", "更多"]);
    assert.equal(result.states[0], "ready");
    assert.ok(result.sizes.every(({ width: buttonWidth, height }) => buttonWidth >= 44 && height >= 44));
    assert.ok(result.actionLeft >= 0 && result.actionRight <= width);
    assert.ok(Math.abs(width - result.actionRight - 12) < 1, `${width}: capsule must stay at the right edge (actual right: ${result.actionRight})`);
    const back = await page.locator(".reader-chrome__back").boundingBox();
    assert.ok(Math.abs(back.x - 12) < 1 && back.x + back.width < result.actionLeft);
    assert.equal(result.pageBelowActions, true);
    assert.ok(result.centerDelta < 0.5);

    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator(".annotation-controls").waitFor();
    const editingActions = await page.locator(".reader-chrome__actions").boundingBox();
    assert.ok(Math.abs(editingActions.x + editingActions.width - result.actionRight) < 1);
    const editingPage = await page.locator(".reader-page-indicator").boundingBox();
    assert.ok(editingPage.y >= editingActions.y + editingActions.height);
    await page.getByRole("button", { name: "编辑", exact: true }).click();

    await page.getByRole("button", { name: "页面位置", exact: true }).click();
    await page.locator(".page-preview-strip").waitFor({ state: "visible" });
    await page.context().close();
  }
});
}

test("grows and caps the real text composer inside an iPad WebKit visual viewport", async (context) => {
  const browser = await webkit.launch({ headless: true });
  context.after(() => browser.close());
  const page = await openMemberReader(browser, { width: 834, height: 420 });
  await showReaderChrome(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator(".annotation-overlay svg").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      pointerId: 1,
      pointerType: "touch",
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height * 0.42,
    };
    element.dispatchEvent(new PointerEvent("pointerdown", init));
    element.dispatchEvent(new PointerEvent("pointerup", init));
  });

  const input = page.getByRole("textbox", { name: "批注文本", exact: true });
  await input.waitFor({ state: "visible" });
  await input.fill("第一行\n第二行\n第三行");
  await assertEventually(page, () => {
    const element = document.querySelector("textarea[aria-label='批注文本']");
    return element instanceof HTMLTextAreaElement && element.clientHeight >= element.scrollHeight;
  });
  const multiline = await input.evaluate((element) => ({
    rows: element.rows,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  assert.equal(multiline.rows, 2);
  assert.ok(multiline.clientHeight >= multiline.scrollHeight);
  assert.equal(multiline.overflowY, "hidden");

  const longValue = Array(30).fill("很多换行仍然可以继续编辑").join("\n");
  await input.fill(longValue);
  await assertEventually(page, () => {
    const element = document.querySelector("textarea[aria-label='批注文本']");
    return element instanceof HTMLTextAreaElement && getComputedStyle(element).overflowY === "auto";
  });
  await page.setViewportSize({ width: 600, height: 320 });
  await assertEventually(page, () => {
    const element = document.querySelector("textarea[aria-label='批注文本']");
    if (!(element instanceof HTMLTextAreaElement)) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
  const longText = await input.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: innerHeight,
      caretAtEnd: element.selectionEnd === element.value.length,
    };
  });
  assert.ok(longText.clientHeight < longText.scrollHeight);
  assert.ok(longText.top >= 0 && longText.bottom <= longText.viewportHeight);
  assert.equal(longText.overflowY, "auto");
  assert.equal(longText.caretAtEnd, true);
  assert.ok(longText.scrollTop > 0);
});

async function openMemberReader(browser, viewport) {
  const browserContext = await browser.newContext({
    viewport,
    colorScheme: "light",
    locale: "zh-CN",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    timezoneId: "Asia/Shanghai",
  });
  await browserContext.route("**/api/**", async (route) => {
    const request = route.request();
    const response = resolveFixtureRequest({
      pathname: new URL(request.url()).pathname,
      method: request.method(),
      identity: "member",
      scenarioId: "reader-controls-narrow",
      cookie: request.headers().cookie ?? "",
    });
    await route.fulfill(response);
  });
  await browserContext.addInitScript(() => {
    localStorage.setItem("reader-gesture-hint-seen", "true");
  });
  const page = await browserContext.newPage();
  await page.goto(`${appOrigin}/choirs/visual-choir/scores/visual-score`, {
    waitUntil: "domcontentloaded",
  });
  await waitForRenderedPdf(page);
  return page;
}

async function showReaderChrome(page) {
  const viewport = page.locator(".page-reader__viewport");
  const bounds = await viewport.boundingBox();
  if (!bounds) throw new Error("reader viewport missing");
  await viewport.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await page.locator(".reader-chrome__actions button[aria-label='编辑']").waitFor({
    state: "visible",
  });
}

async function waitForRenderedPdf(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".page-reader__sheet[data-page-turn-current] .pdf-page-canvas [data-pdf-canvas-active]",
    );
    return canvas instanceof HTMLCanvasElement && canvas.width >= 100 && canvas.height >= 100;
  });
}

async function assertEventually(page, predicate) {
  await page.waitForFunction(predicate);
}
