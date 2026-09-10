import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

test("export preserves multipage source geometry and overlays text and ink on rotated cropped pages", async t => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  const pdf = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const sheet = pdf.addPage([400, 600]); sheet.setCropBox(20, 30, 360, 540); sheet.setRotation(degrees(rotation));
    sheet.drawText(`ORIGINAL PAGE ${rotation}`, { x: 70, y: 300, size: 18 });
    sheet.drawText("SOURCE RED", { x: 70, y: 260, size: 12, color: rgb(1, 0, 0) });
    for (let i = 0; i < 5; i++) sheet.drawLine({ start: { x: 50, y: 170 + i * 10 }, end: { x: 350, y: 170 + i * 10 }, thickness: 1, color: rgb(0, 0, 0) });
  }
  const result = await page.evaluate(async bytes => {
    const { loadPdfDocument } = await import("/src/client/reader/pdf-document.ts");
    const { exportAnnotatedPdf } = await import("/src/client/reader/export-pdf.ts");
    const loaded = loadPdfDocument(new Uint8Array(bytes).buffer);
    const { document: source } = await loaded.promise;
    const annotations = Array.from({ length: 4 }, (_, i) => [
      { layerId: "selected", deleted: false, payload: { kind: "text", pageNumber: i + 1, x: .5, y: .2, fontScale: .04, text: "换气 · Breath\nKeep this long English phrase together when possible and breathe gently" } },
      { layerId: "selected", deleted: false, payload: { kind: "ink", brush: "pen", nib: "round", pressureMode: "uniform", pageNumber: i + 1, strokeWidth: .003, points: [{ x: .1, y: .7 }, { x: .3, y: .7 }] } },
      { layerId: "excluded", deleted: false, payload: { kind: "text", pageNumber: i + 1, x: .5, y: .5, fontScale: .08, text: "EXCLUDED" } },
    ]).flat();
    const blob = await exportAnnotatedPdf(source, annotations, [{ id: "selected", kind: "shared", displayColor: "#ff0000" }]);
    const bytesOut = [...new Uint8Array(await blob.arrayBuffer())];
    const exported = loadPdfDocument(new Uint8Array(bytesOut).buffer);
    const { document: target } = await exported.promise;
    const evidence = [];
    document.body.innerHTML = "";
    const textBounds = (payload, width, height) => {
      // Use the reader's real layout, not a fixed box tied to one OS font.
      const container = document.createElement("div");
      container.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;container-type:inline-size;visibility:hidden`;
      const label = document.createElement("button");
      label.className = "annotation-text";
      label.style.cssText = `left:${payload.x * 100}%;top:${payload.y * 100}%;font-size:${payload.fontScale * 100}cqw`;
      label.textContent = payload.text;
      container.append(label); document.body.append(container);
      const box = label.getBoundingClientRect();
      const bounds = { left: box.left - 2, right: box.right + 2, top: box.top - 2, bottom: box.bottom + 2 };
      container.remove();
      return bounds;
    };
    for (let i = 1; i <= 4; i++) {
      const before = await source.getPage(i), after = await target.getPage(i);
      const viewport = before.getViewport({ scale: 1 });
      const bounds = textBounds(annotations.find(annotation => annotation.payload.pageNumber === i && annotation.payload.kind === "text").payload, viewport.width, viewport.height);
      const render = async sheet => {
        const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
        await sheet.render({ canvas, viewport }).promise;
        return canvas;
      };
      const first = await render(before), last = await render(after);
      const a = first.getContext("2d").getImageData(0, 0, first.width, first.height).data;
      const b = last.getContext("2d").getImageData(0, 0, last.width, last.height).data;
      let sourceLost = 0, textRed = 0, inkRed = 0, strayRed = 0;
      for (let pixel = 0; pixel < a.length / 4; pixel++) {
        const x = pixel % last.width / last.width, y = Math.floor(pixel / last.width) / last.height;
        const inText = x * last.width >= bounds.left && x * last.width <= bounds.right && y * last.height >= bounds.top && y * last.height <= bounds.bottom;
        if (!inText && !(x > .08 && x < .32 && y > .68 && y < .72) && a[pixel * 4] < 80 && a[pixel * 4 + 1] < 80 && b[pixel * 4] > 150) sourceLost++;
        // Linux LCD font antialiasing can make black source glyph edges red.
        // Count only red that was not already present in the original render.
        const isRed = data => data[pixel * 4] > 160 && data[pixel * 4] - data[pixel * 4 + 1] > 60 && data[pixel * 4 + 1] < 180 && data[pixel * 4 + 2] < 180;
        if (isRed(b) && !isRed(a)) {
          if (inText) textRed++;
          else if (x > .08 && x < .32 && y > .68 && y < .72) inkRed++;
          else strayRed++;
        }
      }
      evidence.push({ sourceLost, textRed, inkRed, strayRed, size: [last.width, last.height], targetSize: [after.getViewport({ scale: 1 }).width, after.getViewport({ scale: 1 }).height] });
      last.style.cssText = "max-width:45%;border:1px solid gray;margin:8px"; document.body.append(last);
    }
    await loaded.destroy(); await exported.destroy();
    return { bytesOut, evidence };
  }, [...await pdf.save()]);
  await mkdir("artifacts/verification/pdf-export", { recursive: true });
  await writeFile("artifacts/verification/pdf-export/annotated.pdf", new Uint8Array(result.bytesOut));
  await page.screenshot({ path: "artifacts/verification/pdf-export/pages.png", fullPage: true });
  for (const page of result.evidence) {
    assert.equal(page.sourceLost, 0); assert.ok(page.textRed > 100); assert.ok(page.inkRed > 30); assert.equal(page.strayRed, 0, JSON.stringify(result.evidence)); assert.deepEqual(page.size, page.targetSize);
  }

});

test("reader export uses reading subscriptions even when opened from editing", async t => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage({ serviceWorkers: "block" });
  page.setDefaultTimeout(15000);
  const fixture = createVisualFixtureSession();
  let revoked = false;
  const preferenceWrites = [];
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/preference") && route.request().method() !== "GET") preferenceWrites.push(pathname);
    const response = fixture.resolve({ pathname, method: route.request().method(), identity: "admin", cookie: "" });
    if (revoked && pathname.endsWith("/layers")) {
      const body = JSON.parse(response.body); body.layers = body.layers.filter(layer => layer.sharedSlot !== "E");
      response.body = JSON.stringify(body);
    }
    return route.fulfill(response);
  });
  await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
  const sheet = page.locator(".page-reader__viewport"); await sheet.waitFor();
  await sheet.click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "完成编辑", exact: true }).click();
  await page.getByRole("button", { name: "导出 PDF", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出 PDF" }); await dialog.waitFor();
  assert.equal(await dialog.getByRole("checkbox", { name: "Ensemble", exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "Bass", exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole("checkbox", { name: "我的笔记", exact: true }).isChecked(), true);
  for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.uncheck();
  assert.equal(await dialog.locator("input[type=checkbox]:checked").count(), 0);
  assert.equal(preferenceWrites.length, 0, "export selection must not change reading subscriptions");
  await dialog.getByRole("checkbox", { name: "Ensemble", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "我的笔记", exact: true }).check();
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "导出 PDF", exact: true }).click()]);
  assert.ok(download.suggestedFilename().endsWith(".pdf"));
  assert.equal(await download.failure(), null);
  revoked = true;
  await dialog.getByRole("button", { name: "导出 PDF", exact: true }).click();
  await dialog.getByText("所选笔记层已不可用，请重新选择后导出").waitFor();
  await dialog.getByRole("button", { name: "移除不可用层" }).click();
  await page.context().setOffline(true);
  await dialog.getByRole("button", { name: "导出 PDF", exact: true }).click();
  await dialog.getByText("所选笔记层的完整离线数据尚未准备好，请联网后导出").waitFor();
  for (const checkbox of await dialog.getByRole("checkbox").all()) await checkbox.uncheck();
  const [original] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "导出 PDF", exact: true }).click()]);
  assert.equal(await original.failure(), null);
  assert.equal(preferenceWrites.length, 0, "export selection must not change reading subscriptions");

});

test("personal shapes retain object colors and highlighter exports translucent over the source", async t => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage(); await page.goto(app.origin);
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([500, 500]);
  sheet.drawLine({ start: { x: 40, y: 100 }, end: { x: 460, y: 100 }, thickness: 2, color: rgb(0, 0, 0) });
  const evidence = await page.evaluate(async bytes => {
    const { loadPdfDocument } = await import("/src/client/reader/pdf-document.ts");
    const { exportAnnotatedPdf } = await import("/src/client/reader/export-pdf.ts");
    const loaded = loadPdfDocument(new Uint8Array(bytes).buffer), { document: source } = await loaded.promise;
    const notes = [
      { kind: "shape", shape: "rectangle", x: .1, y: .1, width: .3, height: .3, strokeWidth: .003, color: "#ff0000", pageNumber: 1 },
      { kind: "shape", shape: "ellipse", x: .5, y: .1, width: .3, height: .3, strokeWidth: .003, color: "#0000ff", pageNumber: 1 },
      { kind: "ink", brush: "highlighter", nib: "round", pressureMode: "uniform", points: [{ x: .1, y: .8 }, { x: .9, y: .8 }], strokeWidth: .018, opacity: .3, color: "#ffff00", pageNumber: 1 },
    ].map(payload => ({ layerId: "personal", payload, deleted: false }));
    const blob = await exportAnnotatedPdf(source, notes, [{ id: "personal", kind: "personal", displayColor: "#00ff00" }]);
    const output = loadPdfDocument(await blob.arrayBuffer()), { document: result } = await output.promise;
    const sheet = await result.getPage(1); const canvas = document.createElement("canvas"); canvas.width = canvas.height = 500;
    await sheet.render({ canvas, viewport: sheet.getViewport({ scale: 1 }) }).promise;
    const ctx = canvas.getContext("2d");
    const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    const evidence = { rectangle: pixel(100, 50), ellipse: pixel(325, 50), empty: pixel(325, 125), highlightedWhite: pixel(200, 397), highlightedBlack: pixel(200, 400) };
    document.body.replaceChildren(canvas);
    await loaded.destroy(); await output.destroy(); return evidence;
  }, [...await pdf.save()]);
  assert.ok(evidence.rectangle[0] > 200 && evidence.rectangle[1] < 150);
  assert.ok(evidence.ellipse[2] > 200 && evidence.ellipse[0] < 150);
  assert.deepEqual(evidence.empty, [255, 255, 255]);
  assert.ok(evidence.highlightedWhite[0] > 240 && evidence.highlightedWhite[2] > 150 && evidence.highlightedWhite[2] < 210);
  assert.ok(evidence.highlightedBlack.every(value => value < 100));
  await mkdir("artifacts/verification/pdf-export", { recursive: true });
  await page.screenshot({ path: "artifacts/verification/pdf-export/personal-tools.png" });
});
