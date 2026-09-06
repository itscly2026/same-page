import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

test("real PDF.js permission and network failures reach private diagnostic reports", async (t) => {
  const server = await startVisualServer({ script: "dev" });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  try {
    for (const category of ["permission", "network"]) {
      const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 320, height: 740 } });
      await context.route("**/api/**", async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (category === "network" && pathname.endsWith("/pdf")) return route.abort("internetdisconnected");
        await route.fulfill(pathname.endsWith("/pdf")
          ? { status: 403, body: "private PDF body must not appear" }
          : resolveFixtureRequest({ pathname, method: route.request().method(), identity: "member", cookie: "" }));
      });
      const page = await context.newPage();
      await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`, { waitUntil: "domcontentloaded" });
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByRole("button", { name: "故障诊断", exact: true }).isVisible(), false);
      await page.getByText("更多帮助", { exact: true }).click();
      await page.getByRole("button", { name: "故障诊断", exact: true }).click();
      await page.getByText("查看诊断内容", { exact: true }).click();
      const textbox = page.getByRole("textbox", { name: "可发送给支持人员的诊断内容" });
      await textbox.waitFor();
      const report = await textbox.inputValue();
      assert.doesNotMatch(report, /private PDF|visual-score|visual-choir/);
      const records = JSON.parse(report).records;
      assert.ok(records.some(record => record.operation === "pdf" && record.category === category));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.stop();
  }
});
