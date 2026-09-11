import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { PDFDocument } from "pdf-lib";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

for (const [name, engine] of Object.entries({ chromium, webkit })) test(`${name}: same-stroke and separate-stroke overlap match SVG and exported PDF for round and chisel nibs`, async t => {
  const app = await startVisualServer({ script: "dev" }); const browser = await engine.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage(); await page.goto(app.origin);
  const pdf = await PDFDocument.create(); pdf.addPage([500,500]);
  const evidence = await page.evaluate(async bytes => {
    const { inkSvgPaths } = await import("/src/client/annotations/ink-geometry.ts");
    const { loadPdfDocument } = await import("/src/client/reader/pdf-document.ts");
    const { exportAnnotatedPdf } = await import("/src/client/reader/export-pdf.ts");
    const loaded = loadPdfDocument(new Uint8Array(bytes).buffer), { document: source } = await loaded.promise;
    const rows = [];
    for (const nib of ["round", "chisel"]) {
      const payload = {kind:"ink",brush:"highlighter",nib,pressureMode:"uniform",pageNumber:1,strokeWidth:.06,opacity:.3,color:"#ffff00",points:[{x:.2,y:.5},{x:.8,y:.5},{x:.8,y:.8},{x:.5,y:.8},{x:.5,y:.2}]};
      const second = { ...payload, points: [{x:.65,y:.2},{x:.65,y:.8}] };
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="white"/>${[payload,second].flatMap(ink => inkSvgPaths(ink,1)).map(path=>`<path d="${path}" fill="#ffff00" opacity=".3" fill-rule="evenodd"/>`).join("")}</svg>`;
      const image = new Image(); image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`; await image.decode();
      const screen = document.createElement("canvas"); screen.width=screen.height=500; screen.getContext("2d").drawImage(image,0,0);
      const blob = await exportAnnotatedPdf(source,[payload,second].map(payload=>({layerId:"personal",deleted:false,payload})),[{id:"personal",kind:"personal"}]);
      const output=loadPdfDocument(await blob.arrayBuffer()), {document:result}=await output.promise;
      const sheet=await result.getPage(1), exported=document.createElement("canvas"); exported.width=exported.height=500;
      await sheet.render({canvas:exported,viewport:sheet.getViewport({scale:1})}).promise;
      const sample=canvas=>({single:[...canvas.getContext("2d").getImageData(150,250,1,1).data],cross:[...canvas.getContext("2d").getImageData(250,250,1,1).data],separate:[...canvas.getContext("2d").getImageData(325,250,1,1).data]});
      rows.push({nib,screen:sample(screen),exported:sample(exported)});
      const label = document.createElement("p"); label.textContent = `${nib} · screen / exported PDF`; document.body.append(label,screen,exported);
      await output.destroy();
    }
    await loaded.destroy(); return rows;
  }, [...await pdf.save()]);
  for (const row of evidence) for (const target of ["screen","exported"]) {
    assert.ok(Math.abs(row[target].single[2]-179)<6, JSON.stringify(row));
    assert.ok(Math.abs(row[target].cross[2]-125)<6, JSON.stringify(row));
    assert.ok(Math.abs(row[target].separate[2]-125)<6, JSON.stringify(row));
  }
  await mkdir("artifacts/editor-preview",{recursive:true});
  await page.screenshot({path:`artifacts/editor-preview/${name}-overlap-export.png`,fullPage:true});
});

test("Pencil event samples persist tilt and twist, preview the nib, and keep successful saving quiet", async t => {
  const app = await startVisualServer({script:"dev"}), browser = await chromium.launch();
  t.after(async()=>{await browser.close();await app.stop();});
  const page = await browser.newPage({viewport:{width:1280,height:900}}), fixture=createVisualFixtureSession({dense:true});
  await page.route("**/api/**",route=>route.fulfill(fixture.resolve({pathname:new URL(route.request().url()).pathname,method:route.request().method(),identity:"admin"})));
  await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
  await page.locator(".annotated-pdf-page canvas:not([hidden])").first().waitFor();
  await page.locator(".annotated-pdf-page").first().click({position:{x:280,y:300}});
  await page.getByRole("button",{name:"编辑",exact:true}).click();
  await page.getByRole("button",{name:"荧光笔",exact:true}).click();
  const overlay=page.locator(".annotation-overlay svg").first();
  await overlay.evaluate(element=>{const b=element.getBoundingClientRect();element.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerId:80,pointerType:"pen",buttons:0,clientX:b.left+b.width*.5,clientY:b.top+b.height*.5,tiltX:60,tiltY:15,twist:90}));});
  const path=await page.locator('[aria-label="笔尖预览"] path').getAttribute("d"); assert.ok(path);
  await overlay.evaluate(element=>{const b=element.getBoundingClientRect();const init={bubbles:true,pointerId:80,pointerType:"pen",buttons:1,pressure:.6,tiltX:60,tiltY:15,twist:90};for(const [type,x,y] of [["pointerdown",.2,.4],["pointermove",.65,.4],["pointermove",.65,.6],["pointermove",.4,.6],["pointermove",.4,.25],["pointerup",.4,.25]]) element.dispatchEvent(new PointerEvent(type,{...init,buttons:type==="pointerup"?0:1,clientX:b.left+b.width*x,clientY:b.top+b.height*y}));});
  await page.waitForFunction(async()=>{const {localDatabase}=await import("/src/client/platform/local-database.ts");return (await localDatabase.annotations.toArray()).some(note=>note.state==="draft"&&note.payload?.kind==="ink"&&note.payload.points.length>=5);});
  const note=await page.evaluate(async()=>{const {localDatabase}=await import("/src/client/platform/local-database.ts");return (await localDatabase.annotations.toArray()).find(note=>note.state==="draft"&&note.payload?.kind==="ink");});
  assert.equal(note.payload.nib,"chisel"); assert.equal(note.payload.points[1].tiltX,60); assert.equal(note.payload.points[1].twist,90);
  assert.equal(await page.locator(".reader-save-feedback").count(),0);
  await page.getByRole("button",{name:"工具设置"}).click();
  assert.equal(await page.getByRole("button",{name:"扁头",exact:true}).getAttribute("aria-pressed"),"true");
  await page.screenshot({path:"artifacts/editor-preview/chisel-reader.png"});
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"撤销",exact:true}).click();
  await page.waitForFunction(async()=>{const {localDatabase}=await import("/src/client/platform/local-database.ts");return !(await localDatabase.annotations.toArray()).some(note=>note.payload?.kind==="ink");});
});

for (const [name, engine] of Object.entries({ chromium, webkit })) test(`${name}: pen crossing stays solid and hittable in both pressure modes and exported PDF`, async t => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await engine.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage(); await page.goto(app.origin);
  const pdf = await PDFDocument.create(); pdf.addPage([500, 500]);
  const evidence = await page.evaluate(async bytes => {
    const { inkSvgPaths, inkFillRule, inkHit } = await import("/src/client/annotations/ink-geometry.ts");
    const { loadPdfDocument } = await import("/src/client/reader/pdf-document.ts");
    const { exportAnnotatedPdf } = await import("/src/client/reader/export-pdf.ts");
    const loaded = loadPdfDocument(new Uint8Array(bytes).buffer), { document: source } = await loaded.promise;
    const rows = [];
    for (const pressureMode of ["uniform", "pressure"]) {
      const payload = {kind:"ink",brush:"pen",nib:"round",pressureMode,pageNumber:1,strokeWidth:.06,color:"#ff0000",points:[{x:.2,y:.2,pressure:.4},{x:.8,y:.8,pressure:.8},{x:.2,y:.8,pressure:.6},{x:.8,y:.2,pressure:.8}]};
      const d = inkSvgPaths(payload, 1)[0], path = new Path2D(d);
      const screen = document.createElement("canvas"); screen.width = screen.height = 1000;
      const ctx = screen.getContext("2d");
      let crossing;
      // Find an interior overlap that the old parity rule made transparent.
      for (let y = 400; y < 600 && !crossing; y+=2) for (let x = 400; x < 600; x+=2) {
        if ([[0,0],[-2,0],[2,0],[0,-2],[0,2]].every(([dx,dy]) => ctx.isPointInPath(path,x+dx,y+dy,"nonzero") && !ctx.isPointInPath(path,x+dx,y+dy,"evenodd"))) { crossing = [x,y]; break; }
      }
      if (!crossing) throw new Error("Fixture must exercise an interior self-overlap");
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="white"/><path d="${d}" fill="red" fill-rule="${inkFillRule(payload)}"/></svg>`)}`;
      await image.decode(); ctx.drawImage(image,0,0);
      const blob = await exportAnnotatedPdf(source,[{layerId:"personal",deleted:false,payload}],[{id:"personal",kind:"personal"}]);
      const output = loadPdfDocument(await blob.arrayBuffer()), {document:result} = await output.promise;
      const sheet = await result.getPage(1), exported = document.createElement("canvas"); exported.width=exported.height=1000;
      await sheet.render({canvas:exported,viewport:sheet.getViewport({scale:2})}).promise;
      const sample = canvas => [...canvas.getContext("2d").getImageData(...crossing,1,1).data];
      rows.push({pressureMode, crossing, hit:inkHit(payload,1000,1000,...crossing,0), screen:sample(screen), exported:sample(exported)});
      await output.destroy();
    }
    await loaded.destroy(); return rows;
  }, [...await pdf.save()]);
  for (const row of evidence) {
    assert.equal(row.hit, true, JSON.stringify(row));
    for (const target of ["screen", "exported"]) {
      assert.ok(row[target][0] > 245 && row[target][1] < 10 && row[target][2] < 10, JSON.stringify(row));
    }
  }
});
