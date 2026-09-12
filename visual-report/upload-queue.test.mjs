import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest, visualFixture } from "./fixtures.mjs";

let server;
const deployedOrigin = process.env.SAME_PAGE_UPLOAD_TEST_ORIGIN;
before(async () => { if (!deployedOrigin) server = await startVisualServer({ script: "dev" }); });
after(async () => { await server?.stop(); });

for (const [engine, width] of [[chromium, 390], [webkit, 834]]) {
  test(`serial multi-file uploads and uncertain-result verification in ${engine.name()}`, async () => {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const pending = [];
    const files = [];
    const stored = [];
    let active = 0;
    let peak = 0;
    try {
      await context.route("**/api/**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/choirs/visual-choir/scores" && request.method() === "POST") {
          const name = /filename="([^"]+)"/.exec(request.postDataBuffer()?.toString() ?? "")?.[1];
          files.push(name);
          peak = Math.max(peak, ++active);
          pending.push(async (status = 201) => {
            const score = { ...visualFixture.score, id: name, fileName: name };
            // Both cases commit the file; failure only affects the response.
            stored.push(score);
            active--;
            if (status === 503 && engine === webkit) {
              await route.abort("internetdisconnected");
              return;
            }
            await route.fulfill({ status, json: status === 201 ? { score } : { error: "internal_error" } });
          });
          return;
        }
        const fixture = resolveFixtureRequest({ pathname, method: request.method(), identity: "admin", cookie: "" });
        if (pathname === "/api/choirs/visual-choir/bootstrap" && request.method() === "GET") {
          const body = JSON.parse(fixture.body);
          body.scores.push(...stored);
          fixture.body = JSON.stringify(body);
        }
        await route.fulfill(fixture);
      });
      await page.goto(`${deployedOrigin ?? server.origin}/choirs/visual-choir`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "上传 PDF", exact: true }).click();
      const input = page.getByLabel("选择 PDF 文件");
      const file = (name) => ({ name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7 fixture") });
      await input.setInputFiles([file("a.pdf"), file("b.pdf")]);
      await page.waitForFunction(() => document.querySelectorAll('.upload-list li[data-status="uploading"]').length === 1);
      await input.setInputFiles([file("c.pdf")]);
      await page.getByRole("status").filter({ hasText: "等待 2 份" }).waitFor();
      await expect.poll(() => pending.length).toBe(1);
      assert.deepEqual(files, ["a.pdf"]);
      await pending.shift()();
      await page.waitForFunction(() => document.querySelector('.upload-list li[data-status="success"]')?.textContent.includes("a.pdf"));
      await page.waitForFunction(() => document.querySelector('.upload-list li[data-status="uploading"]')?.textContent.includes("b.pdf"));
      await expect.poll(() => pending.length).toBe(1);
      assert.deepEqual(files, ["a.pdf", "b.pdf"]);
      // Simulate a response lost after the server may already have committed.
      await pending.shift()(503);
      await page.getByRole("alert").filter({ hasText: "队列已暂停" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "重试 b" }).count(), 0);
      assert.equal(files.length, 2);
      await page.getByRole("button", { name: "继续等待项" }).click();
      await page.waitForFunction(() => document.querySelector('.upload-list li[data-status="uploading"]')?.textContent.includes("c.pdf"));
      await expect.poll(() => pending.length).toBe(1);
      await pending.shift()();
      await page.waitForFunction(() => document.querySelectorAll('.upload-list li[data-status="success"]').length === 2);
      assert.equal(peak, 1);
      assert.deepEqual(files, ["a.pdf", "b.pdf", "c.pdf"]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const actionSizes = await page.locator(".upload-list button").evaluateAll((buttons) => buttons.map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
      assert.ok(actionSizes.every((size) => size.width >= 44 && size.height >= 44));
      await page.getByRole("button", { name: "核对 b" }).click();
      await page.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).waitFor();
      assert.equal(await page.getByRole("searchbox", { name: /搜索.*中的乐谱/ }).inputValue(), "b.pdf");
      await page.getByText(/请核对同名文件/).waitFor();
      await page.getByRole("link", { name: /^b$/ }).waitFor();
      assert.equal(files.length, 3);
    } finally { await context.close(); await browser.close(); }
  });
}

for (const [engine, width] of [[chromium, 390], [webkit, 834]]) {
  for (const replacement of [false, true]) test(`real HTTP ${replacement ? "replacement" : "upload"} progress waits for save confirmation in ${engine.name()}`, async () => {
    const { createServer, request: proxyRequest } = await import("node:http");
    const { request: secureProxyRequest } = await import("node:https");
    const { mkdir } = await import("node:fs/promises");
    const uploadPath = `/api/choirs/visual-choir/scores${replacement ? "/visual-score/versions" : ""}`;
    let respond;
    let received = 0;
    let posts = 0;
    const receiver = createServer((request, response) => {
      if (request.url !== uploadPath || request.method !== "POST") {
        const target = new URL(request.url, deployedOrigin ?? server.origin);
        const proxy = (target.protocol === "https:" ? secureProxyRequest : proxyRequest)(target, { method: request.method, headers: { ...request.headers, host: target.host } }, upstream => {
          response.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(response);
        });
        proxy.on("error", () => { response.writeHead(502); response.end(); });
        request.pipe(proxy);
        return;
      }
      posts++;
      request.on("data", chunk => {
        received += chunk.length;
        request.pause();
        setTimeout(() => request.resume(), 15);
      });
      request.on("end", () => {
        respond = () => {
          response.writeHead(201, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          response.end(JSON.stringify(replacement ? { version: visualFixture.score.currentVersion } : { score: { ...visualFixture.score, fileName: "大谱.pdf" } }));
        };
      });
    });
    await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve));
    const receiverOrigin = `http://127.0.0.1:${receiver.address().port}`;
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await context.route("**/api/**", async route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === uploadPath && request.method() === "POST") {
          await route.continue();
          return;
        }
        if (replacement && pathname === uploadPath && request.method() === "GET") {
          await route.fulfill({ json: { revision: 1, currentVersionId: visualFixture.score.currentVersion.id,
            versions: [{ ...visualFixture.score.currentVersion, retentionExpiresAt: null }] } });
          return;
        }
        await route.fulfill(resolveFixtureRequest({ pathname, method: request.method(), identity: "admin", cookie: "" }));
      });
      await page.goto(`${receiverOrigin}/choirs/visual-choir`, { waitUntil: "domcontentloaded" });
      if (replacement) {
        await page.getByRole("button", { name: "排练示例 · 秋日合唱 更多操作" }).click();
        await page.getByRole("menuitem", { name: "替换 PDF" }).click();
      } else {
        await page.getByRole("button", { name: "上传 PDF", exact: true }).click();
      }
      await page.getByLabel(replacement ? "新的 PDF（最多 20 MB、500 页）" : "选择 PDF 文件").setInputFiles({ name: "大谱.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(12 * 1024 * 1024, 32) });
      const progress = page.getByRole("progressbar", { name: "大谱.pdf 传输进度" });
      await expect(page.getByText(/平均.*\/s/)).toBeVisible();
      const value = Number(await progress.getAttribute("value"));
      assert.ok(value > 0 && value < 100, `intermediate transfer progress: ${value}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir("artifacts/verification/upload-288", { recursive: true });
      await page.screenshot({ path: `artifacts/verification/upload-288/${engine.name()}-${replacement ? "replacement" : "upload"}-transfer.png` });
      await expect(page.getByText("传输完成，正在保存…")).toBeVisible({ timeout: 15000 });
      await expect(progress).toHaveAttribute("value", "100");
      await expect(page.getByText(/平均.*\/s/)).toHaveCount(0);
      await expect(page.getByText("上传完成", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: `artifacts/verification/upload-288/${engine.name()}-${replacement ? "replacement" : "upload"}-saving.png` });
      await expect.poll(() => typeof respond, { timeout: 15000 }).toBe("function");
      assert.ok(received >= 12 * 1024 * 1024);
      respond();
      if (replacement) await expect(page.getByRole("button", { name: "确认替换" })).toBeVisible();
      else await expect(page.getByText("上传完成", { exact: true })).toBeVisible();
      await expect(progress).toHaveCount(0);
      assert.equal(posts, 1);
    } finally {
      await context.close(); await browser.close();
      receiver.closeAllConnections();
      await new Promise(resolve => receiver.close(resolve));
    }
  });
}
