import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

// Hold responses instead of relying on timing sleeps: every assertion below is
// made while the relevant HTTP response is still unavailable.
test("desktop and narrow readers preserve local intent and warm display name drafts on slow requests", async t => {
  const server = await startVisualServer({ script: "dev" }); t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const output = "artifacts/issue-225"; await mkdir(output, { recursive: true });
  const evidence = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
    const fixture = createVisualFixtureSession();
    let hold = false;
    const releases = [];
    let puts = 0, settingsReads = 0, remoteName = false;
    await context.route("**/api/**", async route => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      if (request.method() === "PUT" && pathname.endsWith("/preference")) {
        puts++;
        if (hold) await new Promise(resolve => releases.push(resolve));
      }
      if (pathname.endsWith("/settings") && request.method() === "GET") {
        settingsReads++;
        if (hold) await new Promise(resolve => releases.push(resolve));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ name: "示例云盘", nameRevision: 0, displayName: remoteName ? "远端新名称" : "本机已知名称", membershipRevision: settingsReads, canEditDriveInfo: false }) });
      }
      await route.fulfill(fixture.resolve({ pathname, method: request.method(), identity: "member", cookie: request.headers().cookie ?? "", body: request.postDataJSON() }));
    });
    await context.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
    const page = await context.newPage();
    await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`);
    await page.waitForFunction(() => document.querySelector("[data-pdf-canvas-active]")?.width > 100);
    await page.locator(".page-reader__viewport").click();
    await page.getByRole("button", { name: "看哪些笔记", exact: true }).click();
    const ensemble = page.getByRole("checkbox", { name: "显示 Ensemble", exact: true });
    await ensemble.waitFor(); hold = true;
    const initial = await ensemble.isChecked();
    await ensemble.click();
    assert.equal(await ensemble.isChecked(), !initial);
    assert.equal(await page.getByRole("checkbox", { name: "显示 Soprano", exact: true }).isEnabled(), true);
    assert.equal(await page.getByText("第一排男高音这里请统一提前吸气并保持轻声进入", { exact: true }).count(), initial ? 0 : 1);
    await ensemble.click(); await ensemble.click();
    assert.equal(await ensemble.isChecked(), !initial);
    await page.screenshot({ path: `${output}/${width}-pending-preference.png`, fullPage: true });
    hold = false; releases.splice(0).forEach(release => release());
    await page.getByText("已同步。", { exact: true }).waitFor();
    assert.equal(await ensemble.isChecked(), !initial);
    if (width === 1440) {
      hold = true; const before = puts; await ensemble.click();
      const second = await context.newPage();
      await second.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`);
      await second.waitForFunction(() => document.querySelector("[data-pdf-canvas-active]")?.width > 100);
      await second.locator(".page-reader__viewport").click();
      await second.getByRole("button", { name: "看哪些笔记", exact: true }).click();
      const other = second.getByRole("checkbox", { name: "显示 Ensemble", exact: true });
      await other.waitFor(); await other.click();
      assert.equal(puts, before + 1, "second tab waits for the first tab's preference lock");
      hold = false; releases.splice(0).forEach(release => release());
      await second.getByText("已同步。", { exact: true }).waitFor();
      assert.equal(await other.isChecked(), !initial);
      assert.equal(puts, before + 2, "lock holder drains the newer durable intent");
      await second.close();
    }
    await page.goto(`${server.origin}/choirs/visual-choir`);
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    await page.getByRole("button", { name: "云盘内显示名", exact: true }).click();
    const name = page.getByRole("textbox", { name: "我在此云盘的显示名" });
    await name.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll("input")].some(input => input.value === "本机已知名称"));
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "打开云盘菜单" }).click(); hold = true; remoteName = true;
    await page.getByRole("button", { name: "云盘内显示名", exact: true }).click();
    assert.equal(await name.inputValue(), "本机已知名称");
    await name.fill("正在编辑的名称");
    await page.screenshot({ path: `${output}/${width}-warm-name.png`, fullPage: true });
    hold = false; releases.splice(0).forEach(release => release());
    await page.getByRole("button", { name: "保存", exact: true }).waitFor();
    assert.equal(await name.inputValue(), "正在编辑的名称");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    evidence.push({ width, height: 900, puts, settingsReads, checks: ["visibility and score before PUT response", "last toggle wins", "other layer enabled", "warm name visible before GET response", "refresh preserves edited input", "no horizontal overflow", ...(width === 1440 ? ["two tabs serialize the same preference"] : [])] });
    await context.close();
  }
  await writeFile(`${output}/checks.json`, JSON.stringify(evidence, null, 2));
});
