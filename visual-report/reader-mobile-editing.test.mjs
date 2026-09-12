import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";

import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = process.env.READER_MOBILE_TEST_PORT ? Number(process.env.READER_MOBILE_TEST_PORT) : undefined;
let appServer;
let appOrigin = process.env.LAYOUT_TEST_ORIGIN;

before(async () => {
  if (!appOrigin) {
    appServer = await startVisualServer({ script: "dev", port, cwd: repositoryRoot });
    appOrigin = appServer.origin;
  }
});

after(async () => {
  await appServer?.stop();
});

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
test(`${engineName}: reader controls remain reachable without overlap across viewport sizes`, async (context) => {
  const browser = await engine.launch({ headless: true });
  context.after(() => browser.close());
  const page = await openMemberReader(browser, { width: 320, height: 800 });
  await showReaderChrome(page);
  // Resize one real reader; do not replay the same edit/navigation flow at every width.
  for (const width of engineName === "chromium" ? [320, 360, 390] : [320, 768, 834, 1194]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForFunction(() => {
      const controls = [...document.querySelectorAll(".reader-chrome__actions button, .reader-chrome__back")];
      const boxes = controls.map(element => element.getBoundingClientRect());
      return boxes.length >= 4 && boxes.every(box => box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight)
        && boxes.every((box, i) => boxes.slice(i + 1).every(other => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top));
    });
  }
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator(".annotation-controls").waitFor();
  for (const name of ["返回云盘", "笔记图层", "更多"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  await page.locator(".page-preview-strip").waitFor({ state: "visible" });
  const preview = await page.getByRole("slider", { name: "跳转页码" }).boundingBox();
  assert.ok(preview.width >= 44 && preview.height >= 44, `scrubber hit area: ${preview.width} × ${preview.height}`);
  const strip = await page.locator(".page-preview-strip").boundingBox();
  assert.ok(strip.height < 32, "the visible strip stays compact independently of its hit area");
  assert.ok(strip.width < 80, "the two-page fixture stays tightly packed");
  // A finger can land above the miniature strip and still select the last page.
  const hit = { x: preview.x + preview.width - 2, y: strip.y - 2 };
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), hit), "跳转页码");
  await page.mouse.click(hit.x, hit.y);
  await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="2"]').waitFor();
  await page.getByRole("slider", { name: "跳转页码" }).press("Home");
  await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="1"]').waitFor();
  assert.equal(await page.locator(".reader-chrome .reader-page-indicator").count(), 0);
  const positionBadge = await page.locator(".reader-page-indicator").boundingBox();
  assert.ok(positionBadge.height < 32, "the page position is a compact status badge");
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "连续滚动", exact: true }).click();
  const reader = page.locator(".continuous-reader");
  await page.locator('.continuous-reader__page[data-index="1"]').waitFor();
  await reader.evaluate(element => {
    const next = element.querySelector('.continuous-reader__page[data-index="1"]');
    element.scrollTop += next.getBoundingClientRect().top - element.getBoundingClientRect().top - 20;
  });
  await page.waitForFunction(() => document.querySelector(".reader-page-indicator")?.textContent.trim().startsWith("2 /"));
  const position = await reader.evaluate(element => element.scrollTop);
  assert.equal(await page.getByRole("slider", { name: "跳转页码" }).inputValue(), "2");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator('.continuous-reader[data-editing]').waitFor();
  assert.equal(await page.locator('.continuous-reader__page[data-index="1"]').getAttribute("inert"), null);
  assert.equal(await page.locator('.continuous-reader__page[data-index="0"]').getAttribute("inert"), "");
  assert.equal(await reader.evaluate(element => element.scrollTop), position);
});
}

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  for (const layout of ["page", "continuous"]) {
    test(`${engineName}: editing ${layout} turns a zoomed page and centers the destination`, async context => {
      const browser = await engine.launch({ headless: true });
      context.after(() => browser.close());
      const page = await openMemberReader(browser, { width: 834, height: 800 });
      await showReaderChrome(page);
      if (layout === "continuous") {
        await page.getByRole("button", { name: "更多", exact: true }).click();
        await page.getByRole("button", { name: "连续滚动", exact: true }).click();
      }
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      const viewport = page.locator(layout === "page" ? ".page-reader__viewport" : ".continuous-reader");
      await viewport.evaluate(element => {
        const send = (type, id, x) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch", pointerId: id, clientX: x, clientY: 300 }));
        send("pointerdown", 1, 200); send("pointerdown", 2, 300);
        send("pointermove", 2, 400); send("pointerup", 2, 400); send("pointerup", 1, 200);
      });
      await page.waitForFunction(selector => Number(document.querySelector(selector)?.dataset.zoom) === 2, layout === "page" ? ".page-reader__viewport" : ".continuous-reader");
      await viewport.evaluate(element => {
        const content = element.querySelector(".page-reader__content, .continuous-reader__inner");
        const remaining = Math.max(0, content.getBoundingClientRect().right - element.getBoundingClientRect().right);
        const send = (type, id, x) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "touch", pointerId: id, clientX: x, clientY: 300 }));
        send("pointerdown", 3, 500); send("pointerdown", 4, 600);
        send("pointermove", 3, 500 - remaining - 120); send("pointermove", 4, 600 - remaining - 120);
        send("pointerup", 4, 600 - remaining - 120); send("pointerup", 3, 500 - remaining - 120);
      });
      await page.locator('.annotation-overlay[data-editing] svg[aria-label="第 2 页笔记层"]').waitFor();
      await page.waitForFunction(selector => {
        const viewport = document.querySelector(selector);
        const paper = viewport.querySelector('.annotation-overlay[data-editing]');
        if (!paper || Number(viewport.dataset.zoom) > 1) return false;
        const a = viewport.getBoundingClientRect(), b = paper.getBoundingClientRect();
        return Math.abs((a.left + a.right - b.left - b.right) / 2) < 2 && Math.abs((a.top + a.bottom - b.top - b.bottom) / 2) < 5;
      }, layout === "page" ? ".page-reader__viewport" : ".continuous-reader");
      assert.equal(await page.locator('.annotation-overlay[data-editing]').getAttribute("data-tool"), "text");
    });
  }
}

test("grows and caps the real text composer inside an iPad WebKit visual viewport", async (context) => {
  const browser = await webkit.launch({ headless: true });
  context.after(() => browser.close());
  const page = await openMemberReader(browser, { width: 834, height: 420 });
  await showReaderChrome(page);
  await page.getByRole("button", { name: /^(编辑|完成编辑)$/, exact: true }).click();
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

  const input = page.getByRole("textbox", { name: "笔记文本", exact: true });
  await input.waitFor({ state: "visible" });
  await input.fill("第一行\n第二行\n第三行");
  await assertEventually(page, () => {
    const element = document.querySelector("textarea[aria-label='笔记文本']");
    return element instanceof HTMLTextAreaElement && element.clientHeight >= element.scrollHeight;
  });
  const multiline = await input.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(multiline.clientHeight >= multiline.scrollHeight);

  const longValue = Array(60).fill("很多换行仍然可以继续编辑").join("\n");
  await input.fill(longValue);
  await assertEventually(page, () => {
    const element = document.querySelector("textarea[aria-label='笔记文本']");
    return element instanceof HTMLTextAreaElement && element.scrollHeight > element.clientHeight;
  });
  await page.setViewportSize({ width: 600, height: 320 });
  await assertEventually(page, () => {
    const element = document.querySelector("textarea[aria-label='笔记文本']");
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
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: innerHeight,
      caretAtEnd: element.selectionEnd === element.value.length,
    };
  });
  assert.ok(longText.clientHeight < longText.scrollHeight);
  assert.ok(longText.top >= 0 && longText.bottom <= longText.viewportHeight);
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

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: native repeated clicks keep text open and a subsequent blank gesture completes`, async context => {
    const browser = await engine.launch({ headless: true });
    context.after(() => browser.close());
    const page = await openMemberReader(browser, { width: 834, height: 1100 });
    await showReaderChrome(page);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const bounds = await page.locator(".annotation-overlay svg").boundingBox();
    const x = bounds.x + bounds.width * .85, y = bounds.y + bounds.height * .65;
    await page.mouse.dblclick(x, y);
    await page.getByRole("textbox", { name: "笔记文本" }).waitFor();
    await page.mouse.click(x, y);
    assert.equal(await page.getByRole("textbox", { name: "笔记文本" }).count(), 1);
    await page.getByRole("textbox", { name: "笔记文本" }).fill("连续点击后继续输入");
    await page.locator(".annotation-text-composer").click({ position: { x: 20, y: 300 } });
    await page.getByRole("textbox", { name: "笔记文本" }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "连续点击后继续输入", exact: true }).waitFor();
    await page.getByRole("button", { name: "完成编辑", exact: true }).click();
    await page.getByRole("button", { name: "返回云盘", exact: true }).waitFor();
  });
}

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: pen drawing dismisses tool settings without losing the first stroke`, async context => {
    const browser = await engine.launch({ headless: true });
    context.after(() => browser.close());
    const page = await openMemberReader(browser, { width: 834, height: 1100 });
    await showReaderChrome(page);
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("button", { name: "画笔", exact: true }).click();
    await page.getByRole("button", { name: "工具设置", exact: true }).click();
    await page.getByRole("dialog", { name: "工具设置", exact: true }).waitFor();
    await page.getByRole("button", { name: "压感", exact: true }).click();
    await page.getByRole("dialog", { name: "工具设置", exact: true }).waitFor();
    assert.ok(await page.locator('.annotation-overlay svg').evaluate(svg => {
      const box = svg.getBoundingClientRect();
      return svg.contains(document.elementFromPoint(box.x + box.width * .5, box.y + box.height * .4));
    }), 'the popover does not intercept the first contact on the score');
    await page.locator('.annotation-overlay svg').evaluate(svg => {
      const box = svg.getBoundingClientRect();
      const base = { bubbles: true, pointerType: 'pen', pointerId: 42, buttons: 1, pressure: .5, clientX: box.x + box.width * .5, clientY: box.y + box.height * .4 };
      svg.dispatchEvent(new PointerEvent('pointerdown', base));
      svg.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: base.clientX + 40 }));
      svg.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: base.clientX + 40, buttons: 0 }));
    });
    await page.getByRole("dialog", { name: "工具设置", exact: true }).waitFor({ state: 'hidden', timeout: 3000 });
    await page.waitForFunction(async () => {
      const { localDatabase } = await import('/src/client/platform/local-database.ts');
      return (await localDatabase.annotations.toArray()).some(note => note.payload?.kind === 'ink' && note.payload.points.length >= 2);
    });
  });
}
