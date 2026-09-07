import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

test("shared-layer overview leads to details, explicitly saves edits and persists reordering", async t => {
  const app = await startVisualServer({ script: "dev" });
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await app.stop(); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const fixture = createVisualFixtureSession({ id: "shared-layer-management-mobile", identity: "admin" });
  await page.route("**/api/**", route => {
    const request = route.request();
    return route.fulfill(fixture.resolve({ pathname: new URL(request.url()).pathname, method: request.method(), identity: "admin", cookie: "", body: request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null }));
  });
  await page.goto(`${app.origin}/choirs/visual-choir`);
  await page.getByRole("button", { name: "打开云盘菜单", exact: true }).click();
  assert.equal(await page.getByRole("menuitem", { name: "成员与管理员" }).getAttribute("href"), "/choirs/visual-choir/memberships");
  await page.getByRole("menuitem", { name: "共享层", exact: true }).click();
  await page.getByRole("button", { name: "上移 T · Tenor" }).click();
  await page.getByText("顺序已保存。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "上移 T · Tenor" }).waitFor();
  await page.reload();
  const list = page.getByRole("region", { name: "共享层管理列表" });
  await list.getByRole("link").nth(4).waitFor();
  assert.match(await list.getByRole("link").nth(2).innerText(), /T · Tenor/);
  assert.equal(await list.getByRole("textbox").count(), 0);
  await list.getByRole("link", { name: /E · Ensemble/ }).click();
  await page.getByRole("textbox", { name: "名称", exact: true }).fill("合排提醒");
  assert.equal(fixture.diagnostics.requests.filter(request => request.method === "PUT" && request.pathname.endsWith("/settings")).length, 0);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("共享层设置已保存。", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "E · 合排提醒", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "名称", exact: true }).inputValue(), "合排提醒");
});
