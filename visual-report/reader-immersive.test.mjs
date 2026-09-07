import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";

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

for (const [engineName, engine] of Object.entries({chromium, webkit})) {
 test(`${engineName}: preserves the magnified score and pan when entering and leaving editing`, async (context) => {
  const browser = await engine.launch({headless:true});
  context.after(() => browser.close());
  const page = await openMemberReader(browser, {width:834,height:1000});
  await assertPageAlignment(page);
  await showReaderChrome(page);
  await page.getByRole("button", {name:"更多",exact:true}).click();
  for (let step = 0; step < 4; step++) await page.getByRole("button", {name:"放大",exact:true}).click();
  await page.getByRole("button", {name:"更多",exact:true}).click();
  const viewport = page.locator(".page-reader__viewport");
  await viewport.evaluate(element => { element.scrollTop = 180; element.scrollLeft = 110; });
  await assertPageAlignment(page);
  const before = await readView(page);
  assert.equal(before.zoom, 2);
  await page.getByRole("button", {name:"编辑",exact:true}).click();
  await page.locator(".annotation-controls").waitFor();
  assertView(await readView(page), before);
  await page.getByRole("button", {name:"完成编辑",exact:true}).click();
  assertView(await readView(page), before);
 });
}
for (const [engineName, engine] of Object.entries({chromium, webkit})) {
 test(`${engineName}: continuous editing locks one page without changing its scale or position`, async (context) => {
  const browser = await engine.launch({headless:true});
  context.after(() => browser.close());
  const page = await openMemberReader(browser, {width:834,height:700});
  try {
    await showReaderChrome(page);
    await page.getByRole("button", {name:"更多",exact:true}).click();
    await page.getByRole("button", {name:"连续滚动",exact:true}).click();
    await page.getByRole("button", {name:"更多",exact:true}).click();
    await page.getByRole("button", {name:"放大",exact:true}).click();
    await page.getByRole("button", {name:"更多",exact:true}).click();
    await page.locator(".continuous-reader .pdf-page-canvas [data-pdf-canvas-active]").first().waitFor();
    await page.locator(".continuous-reader").evaluate(element => {element.scrollTop = 170; element.scrollLeft = 90;});
    const read = () => page.locator('.continuous-reader__page[data-index="0"] .annotated-pdf-page').evaluate(element => {
     const box = element.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width};
    });
    await assertPageAlignment(page);
    const before = await read();
    await page.getByRole("button", {name:"编辑",exact:true}).click();
    await page.locator(".annotation-controls").waitFor();
    // Toolbar readiness is independent of WebKit's next style update. Wait for
    // the page-lock invariant itself; a persistently visible neighbour still fails.
    const visiblePages = page.locator('.annotated-pdf-page:visible');
    await expect(visiblePages).toHaveCount(1, { timeout: 3000 });
    const focused = await visiblePages.evaluateAll(elements => elements.map(element => {
     const box = element.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width};
    }));
    assert.equal(focused.length,1);
    assertView(focused[0], before);
    await page.mouse.move(400,450);
    await page.mouse.wheel(0,600);
    assertView((await page.locator('.annotated-pdf-page:visible').evaluateAll(elements => elements.map(element => {
     const box = element.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width};
    })))[0],before);
    await page.getByRole("button", {name:"完成编辑",exact:true}).click();
    assertView(await read(), before);
  } catch (error) {
    await recordContinuousEditFailure(page, engineName).catch(evidenceError => console.error("Could not capture reader failure evidence", evidenceError));
    throw error;
  }
 });
}

for (const [engineName, engine] of Object.entries({chromium, webkit})) {
 test(`${engineName}: fitted score respects all four safe area edges`, async (context) => {
  const browser = await engine.launch({headless:true}); context.after(() => browser.close());
  const page = await openMemberReader(browser, {width:1000,height:700});
  await page.locator(".reader-shell").evaluate(element => {
   for (const [side,size] of Object.entries({top:44,right:24,bottom:34,left:59})) element.style.setProperty(`--reader-safe-${side}`,`${size}px`);
  });
  await page.waitForFunction(() => {
   const box = document.querySelector(".page-reader__viewport").getBoundingClientRect();
   const paper = document.querySelector('[data-page-turn-current] .annotated-pdf-page').getBoundingClientRect();
   return box.left >= 59 && box.top >= 44 && box.right <= 976 && box.bottom <= 666 && paper.left >= 59 && paper.top >= 43.5 && paper.right <= 976.5 && paper.bottom <= 666.5;
  });
  const box = await page.locator('[data-page-turn-current] .annotated-pdf-page').boundingBox();
  assert.ok(box.x >= 59 && box.y >= 43.5 && box.x+box.width <= 976.5 && box.y+box.height <= 666.5);
 });
}

async function readView(page) {
 return page.locator(".page-reader__viewport").evaluate(element => {
  const paper = element.querySelector("[data-page-turn-current] .annotated-pdf-page").getBoundingClientRect();
  return {zoom:Number(element.dataset.zoom), x:paper.x,y:paper.y,width:paper.width};
 });
}
function assertView(actual, expected) {
 for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key]-expected[key]) < 1, `${key}: expected ${expected[key]}, got ${actual[key]}`);
}
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

async function recordContinuousEditFailure(page, engineName) {
  const directory = "artifacts/verification/reader-immersive";
  await mkdir(directory, { recursive: true });
  const state = await page.evaluate(() => {
    const reader = document.querySelector(".continuous-reader");
    return {
      editing: reader?.getAttribute("data-editing"),
      scroll: reader ? { top: reader.scrollTop, left: reader.scrollLeft } : null,
      pages: [...document.querySelectorAll(".continuous-reader__page")].map(element => {
        const paper = element.querySelector(".annotated-pdf-page");
        return {
          index: element.getAttribute("data-index"),
          hidden: element.getAttribute("data-edit-hidden"),
          inert: element.hasAttribute("inert"),
          visibility: getComputedStyle(element).visibility,
          paperVisibility: paper ? getComputedStyle(paper).visibility : null,
          paperRect: paper?.getBoundingClientRect().toJSON(),
        };
      }),
    };
  });
  await writeFile(`${directory}/${engineName}-continuous-edit.json`, JSON.stringify(state, null, 2));
  await page.screenshot({ path: `${directory}/${engineName}-continuous-edit.png`, fullPage: true });
}

// Use actual layouts, PDF bitmaps and overlays instead of a mocked virtualizer
// and duplicated getViewport arithmetic in jsdom.
async function assertPageAlignment(page) {
  await expect.poll(() => page.locator(".annotated-pdf-page:visible").first().evaluate(frame => {
    const paper = frame.getBoundingClientRect();
    const canvas = frame.querySelector("canvas[data-pdf-canvas-active]");
    if (!canvas) return false;
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 16) if (pixels[i + 3] && pixels[i] + pixels[i + 1] + pixels[i + 2] < 700) ink++;
    if (ink < 100) return false;
    return [frame.querySelector("canvas[data-pdf-canvas-active]"), frame.querySelector(".annotation-overlay")].every(element => {
      if (!element) return false;
      const box = element.getBoundingClientRect();
      return ["x", "y", "width", "height"].every(key => Math.abs(box[key] - paper[key]) <= 1);
    });
  }), { message: "PDF bitmap and annotation coordinates must share the displayed page bounds" }).toBe(true);
}
