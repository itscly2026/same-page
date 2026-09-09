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
      if (pathname.endsWith("/management")) return route.fulfill({ json: { name: driveName, guestAdmissionMode: "invite", capabilities: { isOwner: true, operations: { operations: ["editDriveInfo"], sharedLayers: [] }, management: { operations: [], sharedLayers: [] } }, layers: [] } });
      if (pathname.endsWith("/memberships")) return route.fulfill({ json: { actorId: "owner", capabilities: { isOwner: true, operations: { operations: [], sharedLayers: [] }, management: { operations: [], sharedLayers: [] } }, memberships: [] } });
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
    await page.getByRole("button", { name: "我在此云盘", exact: true }).click();
    await page.getByRole("menuitem", { name: "云盘内显示名", exact: true }).click();
    await page.getByLabel("我在此云盘的显示名", { exact: true }).getByRole("textbox").fill("新名字");
    await mkdir("artifacts/verification/issue-170", { recursive: true });
    await page.screenshot({ path: `artifacts/verification/issue-170/${name}-display-name.png` });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await expect(page.getByRole("button", { name: "我在此云盘", exact: true })).toHaveText("新");
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    await page.getByRole("link", { name: "基本信息", exact: true }).click();
    await page.getByRole("button", { name: "修改云盘名称", exact: true }).click();
    await page.getByRole("textbox", { name: "云盘名称", exact: true }).fill("周末排练云盘");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "修改云盘名称", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "上传 PDF（需联网）", exact: true }).waitFor();
    await page.getByRole("button", { name: "打开云盘菜单" }).click();
    const management = page.getByRole("navigation", { name: "云盘管理菜单", exact: true });
    const members = management.getByText("成员与权限", { exact: true });
    await expect(members).toBeVisible();
    await expect(page.getByRole("dialog", { name: "云盘菜单" })).toContainText("周末排练云盘");
    await expect(members).toHaveAttribute("aria-disabled", "true");
    await expect(management.getByRole("link")).toHaveCount(0);
    assert.equal(await page.evaluate(() => navigator.onLine), true);
    await expect(page.getByText("访问权限尚未确认，请重试连接。", { exact: true })).toBeVisible();
    await expect(management).not.toContainText("需联网");
    await page.screenshot({ path: `artifacts/verification/issue-170/${name}-renamed-drive.png` });
    await page.getByRole("link", { name: "云盘列表", exact: true }).click();
    await expect(page.getByRole("link", { name: /周末排练云盘/ })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
}

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: ordinary members inspect locked management and both permission views on a phone`, async t => {
    const app = await startVisualServer({ script: "dev" });
    const browser = await engine.launch();
    t.after(async () => { await browser.close(); await app.stop(); });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const fixture = createVisualFixtureSession();
    const empty = { operations: [], sharedLayers: [] };
    const capabilities = { isOwner: false, operations: empty, management: empty };
    await page.route("**/api/**", async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.endsWith("/management")) return route.fulfill({ json: { name: "排练云盘", guestAdmissionMode: "invite", capabilities, layers: [{ slot: "S", name: "Soprano", active: 1 }] } });
      if (pathname.endsWith("/memberships")) return route.fulfill({ json: { actorId: "member", capabilities, memberships: [{ id: "owner", displayName: "小林", isOwner: 1, status: "active", revision: 0, operations: empty, management: empty }, { id: "member", displayName: "小花", isOwner: 0, status: "active", revision: 0, operations: { operations: [], sharedLayers: ["S"] }, management: empty }] } });
      if (pathname.endsWith("/permission-layers")) return route.fulfill({ json: { layers: [{ slot: "S", name: "Soprano" }] } });
      const result = fixture.resolve({ pathname, method: request.method(), identity: "admin", cookie: "" });
      return route.fulfill({ status: result.status, contentType: result.contentType, body: result.body });
    });
    await page.goto(`${app.origin}/choirs/choir-1/settings/admission`);
    await expect(page.getByText("需要邀请码", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /查看与轮换邀请码/ }).click();
    await expect(page.getByText("处理此项可联系 小林。")).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mkdir("artifacts/visual-report", { recursive: true });
    await page.screenshot({ path: `artifacts/visual-report/management-member-${name}.png`, fullPage: true });
    await page.getByRole("link", { name: "查看权限分工", exact: true }).click();
    await page.locator(".view-selector-option").filter({ hasText: "按权限" }).click();
    await expect(page.getByRole("radio", { name: "按权限", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "按权限", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("radio", { name: "按成员", exact: true })).toBeChecked();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "按权限", exact: true })).toBeFocused();
    await page.getByLabel("选择权限").selectOption("layer:S");
    await expect(page.getByRole("region", { name: "可以操作", exact: true }).getByText("小花", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "可以授权", exact: true }).getByText("小林", { exact: true })).toBeVisible();
    await expect(page.getByText("操作权限：Soprano")).toHaveCount(0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `artifacts/visual-report/permissions-member-${name}.png`, fullPage: true });
    await page.goto(`${app.origin}/help`);
    await page.getByRole("link", { name: "故障诊断", exact: true }).click();
    await expect(page.getByRole("heading", { name: "故障诊断", exact: true })).toBeVisible();
  });
}
