import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidence = path.join(root, "artifacts/verification/issue-150");
let server;
before(async () => {
  server = await startVisualServer({ script: "dev", cwd: root });
  await mkdir(evidence, { recursive: true });
});
after(async () => { await server?.stop(); });

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: cached return restores once and background refresh preserves the current view`, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 834, height: 1194 }, locale: "zh-CN", serviceWorkers: "block" });
    const fixture = createVisualFixtureSession();
    let release;
    let waiting = null;
    let requests = 0;
    let unavailable = false;
    const hold = () => { waiting = new Promise(resolve => { release = resolve; }); };
    t.after(() => release?.());
    await context.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const libraryRequest = pathname === "/api/choirs/visual-choir/bootstrap";
      if (libraryRequest) { requests++; if (waiting) await waiting; }
      if (libraryRequest && unavailable) return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      const result = fixture.resolve({ pathname, method: route.request().method(), identity: "admin", cookie: route.request().headers().cookie ?? "" });
      if (libraryRequest && result.status === 200) {
        const data = JSON.parse(result.body);
        data.scores = Array.from({ length: 60 }, (_, i) => ({ ...data.scores[0],
          id: i === 40 ? "visual-score" : `score-${i}`,
          fileName: `${String(i).padStart(3, "0")} 秋日合唱排练与演出乐谱.pdf`,
        }));
        result.body = JSON.stringify(data);
      }
      await route.fulfill(result);
    });
    const page = await context.newPage();
    await page.goto(`${server.origin}/choirs/visual-choir`);
    await expect(page.locator(".file-row")).toHaveCount(60);
    await page.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).fill("秋日");
    const score = page.locator('a.file-row__open[href$="/scores/visual-score"]');
    await score.scrollIntoViewIfNeeded();
    const savedTop = await page.evaluate(() => window.scrollY);
    assert.ok(savedTop > 500);
    await score.click();
    await page.locator("[data-pdf-canvas-active]").first().waitFor();
    hold();
    await page.goBack();
    await expect(page.locator(".file-row")).toHaveCount(60);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(savedTop);
    await expect(page.getByRole("button", { name: "上传 PDF", exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, `${name}-cached-return.png`) });

    // Scroll again before revalidation finishes. The old return target is spent.
    await page.evaluate(() => window.scrollTo(0, 900));
    const currentTop = await page.evaluate(() => window.scrollY);
    release(); waiting = null;
    await expect(page.getByRole("button", { name: "上传 PDF", exact: true })).toBeAttached();
    // WebKit may adjust its scroll anchor by a CSS pixel as management controls return.
    await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - currentTop)).toBeLessThanOrEqual(2);

    hold();
    const before = requests;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect.poll(() => requests).toBe(before + 1);
    await page.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).fill("040");
    await page.getByRole("combobox", { name: "乐谱排序" }).selectOption("updated");
    unavailable = true;
    release(); waiting = null;
    await page.getByText("列表更新失败", { exact: true }).click();
    await expect(page.getByText(/暂时无法更新乐谱列表，当前内容已保留/)).toBeVisible();
    await expect(page.locator(".file-row")).toHaveCount(1);
    await page.screenshot({ path: path.join(evidence, `${name}-refresh-failed.png`) });
    unavailable = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByText(/暂时无法更新乐谱列表，当前内容已保留/)).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: /搜索.*中的乐谱/ })).toHaveValue("040");
    await expect(page.getByRole("combobox", { name: "乐谱排序" })).toHaveValue("updated");
    await page.screenshot({ path: path.join(evidence, `${name}-refreshed.png`) });
    await writeFile(path.join(evidence, `${name}-lifecycle.json`), JSON.stringify({
      engine: name, requests, savedTop, currentTop,
      checks: ["cached return after DOM commit", "cache does not grant management", "no background scroll jump", "coalesced foreground requests", "failed refresh retains content", "retry preserves search and sort"],
      scope: "local application with synthetic network; desktop browser, no real-device or production claim",
    }, null, 2));
  });
}
