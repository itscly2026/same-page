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
    for (let i = 0; i < 5; i++) sheet.drawLine({ start: { x: 50, y: 170 + i * 10 }, end: { x: 350, y: 170 + i * 10 }, thickness: 1, color: rgb(0, 0, 0) });
  }
  const result = await page.evaluate(async bytes => {
    const { loadPdfDocument } = await import("/src/client/reader/pdf-document.ts");
    const { exportAnnotatedPdf } = await import("/src/client/reader/export-pdf.ts");
    const loaded = loadPdfDocument(new Uint8Array(bytes).buffer);
    const { document: source } = await loaded.promise;
    const annotations = Array.from({ length: 4 }, (_, i) => [
      { layerId: "selected", deleted: false, payload: { kind: "text", pageNumber: i + 1, x: .5, y: .2, fontScale: .04, text: "换气 · Breath" } },
      { layerId: "selected", deleted: false, payload: { kind: "ink", pageNumber: i + 1, strokeWidth: .003, points: [{ x: .1, y: .7 }, { x: .3, y: .7 }] } },
      { layerId: "excluded", deleted: false, payload: { kind: "text", pageNumber: i + 1, x: .5, y: .5, fontScale: .08, text: "EXCLUDED" } },
    ]).flat();
    const blob = await exportAnnotatedPdf(source, annotations, [{ id: "selected", displayColor: "#ff0000" }]);
    const bytesOut = [...new Uint8Array(await blob.arrayBuffer())];
    const exported = loadPdfDocument(new Uint8Array(bytesOut).buffer);
    const { document: target } = await exported.promise;
    const evidence = [];
    document.body.innerHTML = "";
    for (let i = 1; i <= 4; i++) {
      const before = await source.getPage(i), after = await target.getPage(i);
      const viewport = before.getViewport({ scale: 1 });
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
        if (!(x > .2 && x < .8 && y > .15 && y < .25) && !(x > .08 && x < .32 && y > .68 && y < .72) && a[pixel * 4] < 80 && a[pixel * 4 + 1] < 80 && b[pixel * 4] > 150) sourceLost++;
        if (b[pixel * 4] > 160 && b[pixel * 4] - b[pixel * 4 + 1] > 60 && b[pixel * 4 + 1] < 180 && b[pixel * 4 + 2] < 180) {
          if (x > .2 && x < .8 && y > .15 && y < .25) textRed++;
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
  await page.route("**/api/**", route => route.fulfill(fixture.resolve({ pathname: new URL(route.request().url()).pathname, method: route.request().method(), identity: "admin", cookie: "" })));
  await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
  const sheet = page.locator(".page-reader__viewport"); await sheet.waitFor();
  await sheet.click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("button", { name: "导出 PDF", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出 PDF" }); await dialog.waitFor();
  assert.equal(await dialog.getByRole("checkbox", { name: "Ensemble", exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "Bass", exact: true }).isChecked(), false);
  assert.equal(await dialog.getByRole("checkbox", { name: "我的笔记", exact: true }).isChecked(), true);
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "导出 PDF", exact: true }).click()]);
  assert.ok(download.suggestedFilename().endsWith(".pdf"));
  assert.equal(await download.failure(), null);
});
