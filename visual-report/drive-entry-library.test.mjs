import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidence = path.join(root, "artifacts/verification/issue-140");
let server;
before(async () => { server = await startVisualServer({ script: "dev", cwd: root }); await mkdir(evidence, { recursive: true }); });
after(async () => { await server?.stop(); });

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: membership entry and compact library support touch, keyboard and offline recovery`, async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), `same-page-140-${name}-`));
    const context = await engine.launchPersistentContext(profile, { headless: true, locale: "zh-CN", serviceWorkers: "block" });
    t.after(async () => { await context.close(); await rm(profile, { recursive: true, force: true }); });
    // This fixture exercises real downloads, checksums and IndexedDB. Only the
    // installed app-shell guard is stubbed; PWA handover is covered separately.
    await context.addInitScript(() => { navigator.serviceWorker.getRegistration = async () => ({ active: {} }); });
    const fixture = createVisualFixtureSession();
    let driveCount = 1;
    let failPdf = true;
    let longList = false;
    let empty = false;
    const requests = [];
    await context.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      requests.push(pathname);
      if (failPdf && pathname.includes("/versions/") && pathname.endsWith("/pdf")) return route.fulfill({ status: 503, body: "injected failure" });
      const result = fixture.resolve({ pathname, method: route.request().method(), identity: "member", cookie: route.request().headers().cookie ?? "" });
      if (result.contentType.startsWith("application/json")) {
        const data = JSON.parse(result.body);
        if (pathname === "/api/choirs") data.memberships = Array.from({ length: driveCount }, (_, i) => ({ ...data.memberships[0], id: `member-${i}`, choir: { ...data.memberships[0].choir, ...(i ? { id: `drive-${i}`, name: "周末排练与演出云盘".repeat(6) } : {}) } }));
        if (data?.scores) {
          if (empty) data.scores = [];
          else if (longList) data.scores = Array.from({ length: 100 }, (_, i) => ({ ...data.scores[0], id: i ? `score-${i}` : data.scores[0].id, fileName: `${String(i).padStart(3, "0")} ${"秋日合唱排练与正式演出全声部附歌词".repeat(5)}.pdf` }));
        }
        result.body = JSON.stringify(data);
      }
      await route.fulfill(result);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(server.origin);
    await page.locator(".file-row").first().waitFor();
    assert.equal(new URL(page.url()).pathname, "/choirs/visual-choir");
    assert.equal(await page.getByRole("link", { name: "访问公开体验云盘" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "上传 PDF", exact: true }).count(), 0);
    await page.getByRole("searchbox", { name: "搜索乐谱" }).fill("秋日");
    assert.equal(await page.locator(".file-row").count(), 1);
    await page.getByRole("combobox", { name: "乐谱排序" }).selectOption("name");
    const row = page.locator(".file-row").first();
    assert.equal(await row.locator(".file-row__size").count(), 0);
    await row.getByRole("button", { name: /更多操作/ }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "文件信息", exact: true }).press("Enter");
    await page.getByRole("dialog", { name: "文件信息" }).waitFor();
    await capture(page, `${name}-file-info`);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await row.getByRole("button", { name: /下载离线副本：/ }).click();
    await page.getByRole("button", { name: "重试下载", exact: true }).waitFor();
    await capture(page, `${name}-offline-failed`);
    failPdf = false;
    await page.getByRole("button", { name: "重试下载", exact: true }).click();
    await page.getByText("已保存在这台设备上，断网也能打开。", { exact: true }).waitFor().catch(async error => { await capture(page, `${name}-unexpected-failure`); throw new Error(`${error.message}\n${await page.locator(".offline-score-details").innerText()}`); });
    await capture(page, `${name}-offline-ready`);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await row.getByRole("link").click();
    await page.locator("[data-pdf-canvas-active]").first().waitFor();
    await page.goBack();
    await page.locator(".file-row").first().waitFor();
    assert.equal(await page.getByRole("searchbox", { name: "搜索乐谱" }).inputValue(), "秋日");
    assert.equal(await page.getByRole("combobox", { name: "乐谱排序" }).inputValue(), "name");
    await page.getByRole("searchbox", { name: "搜索乐谱" }).fill("不存在");
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    assert.equal(await page.locator(".file-row").count(), 3);
    longList = true;
    await page.reload();
    await page.locator(".file-row").nth(99).waitFor();
    for (const [width, height] of [[390, 844], [834, 1194], [1194, 834], [1440, 1000]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: page overflow`);
      for (const selector of [".file-row__open", ".offline-score-button", ".file-menu-button"]) {
        const box = await page.locator(selector).first().boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target`);
      }
      await capture(page, `${name}-long-library-${width}`);
    }
    empty = true;
    await page.reload();
    await page.getByText("管理员上传乐谱后，会显示在这里。", { exact: true }).waitFor();
    await capture(page, `${name}-empty-library`);
    driveCount = 2;
    await page.goto(server.origin);
    await page.locator(".membership-row").nth(1).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(page, `${name}-multiple-drives`);
    driveCount = 0;
    await page.reload();
    await page.getByText(/还没有已加入的云盘/).waitFor();
    await capture(page, `${name}-zero-drives`);
    await page.getByRole("button", { name: "加入新云盘", exact: true }).click();
    await page.getByRole("dialog", { name: "加入新云盘" }).waitFor();
    await writeFile(path.join(evidence, `${name}-interactions.json`), JSON.stringify({ engine: name, device: "desktop browser with simulated viewports", api: "synthetic fixture", appShellGuard: "stubbed; not an offline app launch test", verified: ["single-drive replace", "zero/multiple members", "search/clear/sort", "keyboard file info", "download failure/retry/checksum/IndexedDB", "open rendered PDF and return", "100 long filenames", "390/834/1194/1440 widths and 44px targets"], requests }, null, 2));
  });
}
async function capture(page, file) { await page.screenshot({ path: path.join(evidence, `${file}.png`) }); }
