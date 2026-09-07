import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium, webkit, expect } from "@playwright/test";
import { startVisualServer } from "./setup.mjs";
import { createVisualFixtureSession } from "./fixtures.mjs";

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: members edit their display name and administrators rename the drive`, async t => {
    const app = await startVisualServer({ script: "dev" });
    const browser = await engine.launch();
    t.after(async () => { await browser.close(); await app.stop(); });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const fixture = createVisualFixtureSession();
    let displayName = "林";
    let driveName = "示例云盘";
    let failRefresh = false;
    await page.route("**/api/**", async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (failRefresh && pathname.endsWith("/bootstrap")) return route.fulfill({ status: 503, body: "injected refresh failure" });
      if (pathname.endsWith("/settings")) return route.fulfill({ json: { name: driveName, nameRevision: 0, displayName, membershipRevision: 0, canEditDriveInfo: true } });
      if (request.method() === "PATCH") {
        const data = request.postDataJSON();
        if (pathname.endsWith("/display-name")) displayName = data.displayName;
        else if (pathname.endsWith("/name")) { driveName = data.name; failRefresh = true; }
        else assert.fail(`Unexpected mutation: ${pathname}`);
        return route.fulfill({ json: { revision: 1 } });
      }
      const result = fixture.resolve({ pathname, method: request.method(), identity: "admin", cookie: "" });
      if (result.contentType.startsWith("application/json")) {
        const data = JSON.parse(result.body);
        if (data.choir) data.choir.name = driveName;
        if (data.memberships) for (const membership of data.memberships) { membership.displayName = displayName; membership.choir.name = driveName; }
        result.body = JSON.stringify(data);
      }
      await route.fulfill(result);
    });
    await page.goto(`${app.origin}/choirs/visual-choir`);
    await page.getByRole("button", { name: "上传 PDF", exact: true }).waitFor();
    await page.getByRole("button", { name: "用户菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "我在此云盘的显示名", exact: true }).click();
    await page.getByLabel("我在此云盘的显示名", { exact: true }).getByRole("textbox").fill("新名字");
    await mkdir("artifacts/verification/issue-170", { recursive: true });
    await page.screenshot({ path: `artifacts/verification/issue-170/${name}-display-name.png` });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await expect(page.getByRole("button", { name: "用户菜单", exact: true })).toHaveText("新");
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    await page.getByRole("menuitem", { name: "云盘名称", exact: true }).click();
    await page.getByRole("textbox", { name: "云盘名称", exact: true }).fill("周末排练云盘");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: "周末排练云盘", exact: true }).waitFor({ state: "attached" });
    await page.reload();
    await page.getByRole("button", { name: "上传 PDF（需联网）", exact: true }).waitFor();
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    await page.getByRole("menuitem", { name: "成员与权限" }).waitFor();
    await expect(page.getByRole("dialog", { name: "云盘菜单" })).toContainText("周末排练云盘");
    await expect(page.getByRole("menuitem", { name: "成员与权限" })).toHaveAttribute("aria-disabled", "true");
    await page.screenshot({ path: `artifacts/verification/issue-170/${name}-renamed-drive.png` });
    await page.getByRole("link", { name: "返回所有云盘", exact: true }).click();
    await expect(page.getByRole("link", { name: /周末排练云盘/ })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
}
