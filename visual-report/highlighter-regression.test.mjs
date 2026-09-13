import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium, webkit } from "playwright";
import { PDFDocument } from "pdf-lib";
import { resolveFixtureRequest } from "./fixtures.mjs";
import { startVisualServer } from "./setup.mjs";
import { regressionHighlighter } from "../src/test/highlighter-fixture.ts";

for (const [name, engine] of Object.entries({chromium,webkit})) for (const sample of ["regression", "budget"]) {
  test(`${name}: reading turns survive highlighter ${sample}`, async t => {
    const app = await startVisualServer({script:"dev"}), browser=await engine.launch();
    t.after(async()=>{await browser.close();await app.stop();});
    const page=await browser.newPage({viewport:{width:820,height:1148},reducedMotion:"reduce"});
    const errors=[]; page.on("pageerror",error=>errors.push(error.message));
    const pdf=await PDFDocument.create(); pdf.addPage([500,700]);pdf.addPage([500,700]);
    const bytes=Buffer.from(await pdf.save());
    const selectedScore=JSON.parse(resolveFixtureRequest({pathname:"/api/choirs/visual-choir/scores/visual-score/sync",identity:"member"}).body).score;
    selectedScore.currentVersion={...selectedScore.currentVersion,sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    await page.route("**/api/**", async route=>{
      const request=route.request(), pathname=new URL(request.url()).pathname;
      const response=resolveFixtureRequest({pathname,method:request.method(),identity:"member",pdf:bytes,selectedScore});
      if (pathname.endsWith("/sync") || pathname.endsWith("/annotations")) {
        const body=JSON.parse(response.body), data=body.annotations ?? body;
        const template=data.objects[0];
        const payload=regressionHighlighter();
        if(sample === "budget") payload.points=Array.from({length:5000},(_,i)=>({x:i%2 ? .8 : .2,y:.5}));
        data.objects=[{...template,payload}];
        response.body=JSON.stringify(body);
      }
      await route.fulfill(response);
    });
    await page.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
    await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
    await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="1"] canvas:not([hidden])').waitFor();
    const viewport=page.locator(".page-reader__viewport"), bounds=await viewport.boundingBox();
    for(let i=0;i<4;i++){
      await viewport.click({position:{x:bounds.width*.9,y:bounds.height*.5}});
      await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="2"] [data-ink-stroke]').first().waitFor();
      assert.equal(await page.getByText("此笔迹已简化显示").count(),sample === "budget" ? 1 : 0);
      assert.equal(await page.getByRole("alert").count(),0);
      if(i===0){await mkdir("artifacts/editor-preview",{recursive:true});await page.screenshot({path:`artifacts/editor-preview/${name}-highlighter-${sample}.png`});}
      await viewport.click({position:{x:bounds.width*.1,y:bounds.height*.5}});
      await page.locator('.page-reader__sheet[data-page-turn-current][data-page-number="1"]').waitFor();
    }
    assert.deepEqual(errors,[]);
  });
}
