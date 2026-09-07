import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import path from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { expectSampleScoreContent } from "./pdf-content.mjs";
import { startStorageFixture } from "./storage-fixture.mjs";

test("real Worker D1/R2 score survives a browser restart offline via IndexedDB", { timeout: 90_000 }, async (t) => {
  const fixture = await startStorageFixture();
  t.after(() => fixture.stop());
  const profilePath = await mkdtemp(path.join(tmpdir(), "same-page-browser-"));
  t.after(() => rm(profilePath, { recursive: true, force: true }));
  let context = await chromium.launchPersistentContext(profilePath, { headless: true, serviceWorkers: "allow" });
  t.after(() => context.close());
  const page = await context.newPage();
  let stage = "online admission";
  try {
    await page.goto(fixture.origin);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.getByRole("link", { name: "先看示例", exact: true }).click();
    await page.getByRole("link").filter({ hasText: fixture.fileName.replace(/\.pdf$/i, "") }).waitFor();
    stage = "verified download";
    await page.getByRole("button", { name: /^离线副本：/ }).click();
    await page.getByRole("button", { name: "下载离线副本", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /^可离线使用$/ }).waitFor();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    stage = "R2 delivery";
    const pdf = await context.request.get(`${fixture.origin}/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/versions/${fixture.versionId}/pdf`);
    assert.equal(pdf.status(), 200);
    assert.deepEqual(await pdf.body(), fixture.pdf);
    stage = "fresh page offline read";
    await context.close();
    await fixture.stop(); // The backend is physically gone before the browser restarts.
    context = await chromium.launchPersistentContext(profilePath, { headless: true, serviceWorkers: "allow" });
    await context.setOffline(true);
    const offlinePage = await context.newPage();
    await offlinePage.goto(`${fixture.origin}/choirs/${fixture.choirId}/scores/${fixture.scoreId}`);
    await expectSampleScoreContent(offlinePage);
    // Storage is exercised through product download/reopen, never preloaded or mocked.
    assert.equal(await offlinePage.evaluate(async () => {
      try { await fetch("/api/health"); return false; } catch { return true; }
    }), true, "offline rendering cannot depend on a reachable Worker");
    stage = "passed";
  } catch (error) {
    console.error(`Storage smoke failed at ${stage}; local server:\n${fixture.logs.join("")}`);
    throw error;
  } finally {
    await mkdir("artifacts/verification", { recursive: true });
    await writeFile(`artifacts/verification/storage-smoke-${randomUUID()}.json`, JSON.stringify({ source: fixture.buildId, stage, scenario: "synthetic guest score: D1/R2 -> IndexedDB -> offline page", apiMocks: false }, null, 2));
    await context.close();
  }
});
