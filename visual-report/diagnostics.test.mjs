import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { startViteServer } from "../scripts/vite-server.mjs";
import { resolveFixtureRequest } from "./fixtures.mjs";

test("real reader reports PDF permission, network and malformed bootstrap failures safely", async (t) => {
  const server = await startViteServer({ script: "dev" });
  t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ["pdf-denied", "pdf-network", "bad-bootstrap"]) {
      const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 320, height: 740 } });
      await context.route("**/api/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (scenario === "pdf-network" && pathname.endsWith("/pdf") && route.request().method() === "GET") {
          await route.abort("internetdisconnected");
        } else if (scenario === "pdf-denied" && pathname.endsWith("/pdf") && route.request().method() === "GET") {
          await route.fulfill({ status: 403, body: "private PDF body must not appear" });
        } else if (scenario === "bad-bootstrap" && pathname.endsWith("/scores/visual-score/bootstrap")) {
          await route.fulfill({ status: 200, body: '{"secret":"private PDF body must not appear"}', headers: { "X-Same-Page-Request-Id": "11111111-1111-4111-8111-111111111111" } });
        } else {
          await route.fulfill(resolveFixtureRequest({ pathname, method: route.request().method(), identity: "member", cookie: "" }));
        }
      });
      const page = await context.newPage();
      await page.goto(`${server.origin}/choirs/visual-choir/scores/visual-score`, { waitUntil: "domcontentloaded" });
      await page.getByRole("alert").waitFor();
      if (scenario === "bad-bootstrap") assert.match(await page.getByRole("alert").innerText(), /服务暂时不可用或返回内容异常/);
      await page.getByRole("link", { name: "故障诊断", exact: true }).click();
      const textbox = page.getByRole("textbox", { name: "可发送给支持人员的诊断内容" });
      await textbox.waitFor();
      const report = await textbox.inputValue();
      assert.doesNotMatch(report, /private PDF|visual-score|visual-choir/);
      const records = JSON.parse(report).records;
      assert.ok(records.some((record) => scenario.startsWith("pdf-")
        ? record.operation === "pdf" && record.category === (scenario === "pdf-network" ? "network" : "permission")
        : record.operation === "drive" && record.stage === "decode" && record.requestId === "11111111-1111-4111-8111-111111111111"));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.stop();
  }
});
