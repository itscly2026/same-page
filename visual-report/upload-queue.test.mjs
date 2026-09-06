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
        if (pathname === "/api/choirs/visual-choir/scores" && request.method() === "GET") {
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
      assert.equal(await page.getByRole("button", { name: "重试 b.pdf" }).count(), 0);
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
      await page.getByRole("button", { name: "核对 b.pdf" }).click();
      await page.getByRole("searchbox", { name: "搜索乐谱" }).waitFor();
      assert.equal(await page.getByRole("searchbox", { name: "搜索乐谱" }).inputValue(), "b.pdf");
      await page.getByText(/请核对同名文件/).waitFor();
      await page.getByRole("link", { name: /b\.pdf/ }).waitFor();
      assert.equal(files.length, 3);
    } finally { await context.close(); await browser.close(); }
  });
}
