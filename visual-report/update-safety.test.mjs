import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

test("a blurred admission form and its pending submission veto background updates", async t => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage({ serviceWorkers: "block" });
  const fixture = createVisualFixtureSession();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/bootstrap")) return route.fulfill({ status: 403, body: "{}" });
    if (pathname === "/api/guest/choirs/visual-choir") return route.fulfill({ json: { choir: { id: "visual-choir", name: "开放云盘", guestAdmissionMode: "open" }, entryKind: "admission" } });
    if (pathname === "/api/choirs/join") { await pending; return route.fulfill({ status: 503, body: "{}" }); }
    return route.fulfill(fixture.resolve({ pathname, method: route.request().method(), identity: "admin", cookie: "" }));
  });
  await page.goto(`${app.origin}/choirs/visual-choir`);
  await page.getByRole("textbox", { name: "显示名" }).fill("排练者");
  await page.getByRole("heading", { name: "开放云盘" }).click();
  await page.waitForTimeout(3200);
  const safe = () => page.evaluate(async () => (await import("/src/client/updates/update-safety.ts")).canApplyUpdate());
  assert.equal(await safe(), false);
  await page.getByRole("button", { name: "加入并进入" }).click();
  await page.waitForTimeout(3200);
  assert.equal(await safe(), false);
  release();
});
