import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { before, after, test } from "node:test";
import { chromium, webkit } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";
let app;
before(async () => { app = await startVisualServer({ script: "dev" }); });
after(async () => { await app?.stop(); });
async function openReader(t, engine) {
  const browser = await engine.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1194, height: 900 } });
  page.setDefaultTimeout(15_000);
  const fixture = createVisualFixtureSession({ dense: true });
  await page.route("**/api/**", route => route.fulfill(fixture.resolve({ pathname: new URL(route.request().url()).pathname, method: route.request().method(), identity: "admin" })));
  await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
  await page.locator(".annotated-pdf-page canvas:not([hidden])").first().waitFor();
  await page.locator(".annotated-pdf-page").first().click({ position: { x: 280, y: 300 } });
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "画笔", exact: true }).click();
  return page;
}
async function pointer(page, type, x, y, pose = {}) {
  await page.locator(".annotation-overlay svg").first().evaluate((element, args) => {
    const b = element.getBoundingClientRect();
    element.dispatchEvent(new PointerEvent(args.type, { bubbles: true, cancelable: true, pointerId: 80, pointerType: "pen", button: 0, buttons: args.type === "pointerup" ? 0 : 1, pressure: .6, clientX: b.left + b.width * args.x, clientY: b.top + b.height * args.y, ...args.pose }));
  }, { type, x, y, pose });
}
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  test(`${name}: crossing pen ink remains painted in live and saved SVG`, async t => {
    const page = await openReader(t, engine);
    await pointer(page, "pointerdown", .2, .2);
    const initialPath = await page.locator("[data-ink-draft]").getAttribute("d");
    await page.locator(".annotation-overlay svg").first().evaluate(element => {
      const b = element.getBoundingClientRect();
      for (const [x,y] of [[.8,.8],[.2,.8],[.8,.2]]) element.dispatchEvent(new PointerEvent("pointermove", {bubbles:true,pointerId:80,pointerType:"pen",buttons:1,pressure:.6,clientX:b.left+b.width*x,clientY:b.top+b.height*y}));
    });
    await page.waitForFunction(d => document.querySelector("[data-ink-draft]")?.getAttribute("d") !== d, initialPath);
    const livePath = await page.locator("[data-ink-draft]").getAttribute("d");
    const sample = async selector => page.locator(selector).last().evaluate(async element => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="white"/>${element.outerHTML}</svg>`;
      const image = new Image(); image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1000;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
      // perfect-freehand streamlining moves the crossing slightly off (500,500).
      const pixels = ctx.getImageData(0, 0, 1000, 1000).data;
      image.src = `data:image/svg+xml,${encodeURIComponent(svg.replaceAll('fill-rule="evenodd"', 'fill-rule="nonzero"'))}`;
      await image.decode(); ctx.drawImage(image, 0, 0);
      const solid = ctx.getImageData(0, 0, 1000, 1000).data;
      return { missing: [...pixels].filter((value, i) => i % 4 === 1 && value - solid[i] > 80).length };
    });
    const live = await sample("[data-ink-draft]");
    assert.equal(live.missing, 0, "self-crossing pen outline has transparent holes");
    await pointer(page, "pointerup", .8, .2);
    await page.locator("[data-ink-draft]").waitFor({ state: "hidden" });
    await page.waitForFunction(d => [...document.querySelectorAll("[data-ink-stroke]")].some(path => path.getAttribute("d") === d), livePath);
    assert.deepEqual(await sample("[data-ink-stroke]"), live);
  });
  test(`${name}: Pencil-only taps change settings without compatibility clicks`, async t => {
    const page = await openReader(t, engine);
    await page.getByRole("button", { name: "工具设置", exact: true }).click();
    const pressure = page.getByRole("button", { name: "压感", exact: true });
    // Replay Pencil contact without a compatibility click (the affected device sequence).
    await pressure.evaluate(element => {
      const b = element.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, pointerId: 81, pointerType: "pen", button: 0, clientX: b.x+b.width/2, clientY: b.y+b.height/2 };
      element.dispatchEvent(new PointerEvent("pointerdown", {...init, buttons:1}));
      element.dispatchEvent(new PointerEvent("pointerup", {...init, buttons:0}));
    });
    await page.waitForFunction(() => document.querySelector('.annotation-pressure-options button:last-child')?.getAttribute('aria-pressed') === 'true', null, { timeout: 1000 });
    await page.keyboard.press("Escape");
  });
  test(`${name}: save checkpoints do not flash the toolbar`, async t => {
    const page = await openReader(t, engine);
    await page.locator(".annotation-controls").evaluate(element => {
      window.pencilToolbar = element;
      window.pencilToolbarChanges = [];
      window.pencilToolbarObserver = new MutationObserver(records => window.pencilToolbarChanges.push(...records.map(r => r.attributeName)));
      window.pencilToolbarObserver.observe(element, { attributes: true, subtree: true, attributeFilter: ["disabled", "data-disabled", "hidden"] });
    });
    await pointer(page, "pointerdown", .2, .3);
    for (let i=1; i<=8; i++) await pointer(page, "pointermove", .2+i*.05, .3);
    await pointer(page, "pointerup", .6, .3);
    assert.deepEqual(await page.evaluate(() => { window.pencilToolbarObserver.disconnect(); return {same:window.pencilToolbar===document.querySelector('.annotation-controls'), changes:window.pencilToolbarChanges}; }), {same:true,changes:[]});
  });
  test(`${name}: quiet hover uses roll and ignores tilt`, async t => {
    const page = await openReader(t, engine);
    await pointer(page, "pointermove", .5, .5, {buttons:0,pressure:0});
    assert.equal(await page.locator(".annotation-hover-tool").count(), 0);
    const dot = page.locator('[aria-label="笔尖预览"] ellipse');
    assert.notEqual(await dot.getAttribute("fill"), "none");
    await page.getByRole("button", {name:"荧光笔",exact:true}).click();
    const hover = page.locator('[aria-label="笔尖预览"] path');
    await pointer(page,"pointermove",.5,.5,{buttons:0,pressure:0,twist:0});
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const initial = await hover.getAttribute("d");
    await pointer(page,"pointermove",.5,.5,{buttons:0,pressure:0,twist:0,tiltX:60,tiltY:30});
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await hover.getAttribute("d"),initial);
    await pointer(page,"pointermove",.5,.5,{buttons:0,pressure:0,twist:90,tiltX:60,tiltY:30});
    await page.waitForFunction(previous => document.querySelector('[aria-label="笔尖预览"] path')?.getAttribute("d") !== previous, initial);
    assert.notEqual(await hover.getAttribute("d"),initial);
    await mkdir("artifacts/editor-preview", {recursive:true});
    await page.screenshot({path:`artifacts/editor-preview/${name}-quiet-hover.png`});
    await page.getByRole("button", {name:"整条橡皮",exact:true}).click();
    await pointer(page,"pointermove",.5,.5,{buttons:0,pressure:0});
    const shadow = page.locator('[aria-label="笔尖预览"] ellipse');
    assert.equal(await shadow.getAttribute("stroke"),null);
    assert.ok(Number(await shadow.getAttribute("fill-opacity")) <= .15);
    await pointer(page,"pointermove",.5,.35,{buttons:0,pressure:0});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.locator(".annotation-overlay svg").first().boundingBox();
    const shot = await page.screenshot({clip:{x:bounds.x+bounds.width*.5-25,y:bounds.y+bounds.height*.35-25,width:50,height:50}});
    const fade = await page.evaluate(async data => {
      const image = new Image(); image.src = data; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width=canvas.height=50;
      const context = canvas.getContext("2d"); context.drawImage(image,0,0);
      return [0,7,12,17].map(offset => context.getImageData(25+offset,25,1,1).data[1]);
    }, `data:image/png;base64,${shot.toString("base64")}`);
    assert.ok(fade[0] > 220 && fade[0]+5 < fade[1] && fade[1]+3 < fade[2] && fade[3] >= 253, `shadow must fade smoothly into the page: ${fade}`);
    await page.screenshot({path:`artifacts/editor-preview/${name}-eraser-hover.png`});
  });
}
