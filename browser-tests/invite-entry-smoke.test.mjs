import assert from "node:assert/strict";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

test("valid invitations automatically admit guests, existing members and named new members", { timeout: 90000 }, async t => {
  const fixture = await startStorageFixture({ authenticated: true, invite: true, nonMember: true });
  t.after(() => fixture.stop());
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const mode of ["fresh", "warm", "member", "new-member"]) {
    const context = await browser.newContext();
    try {
      if (mode === "member" || mode === "new-member") {
        const account = fixture.accounts[mode === "new-member" ? 1 : 0];
        assert.equal((await context.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } })).status(), 200);
      }
      const page = await context.newPage();
      let admissions = 0;
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/guest/session" && request.method() === "POST") {
          admissions += 1;
          // Record only credential-free state; never emit the invitation URL.
          assert.equal(new URL(page.url()).hash === "", true, "invitation fragment must be cleared");
        }
      });
      if (mode === "warm") {
        await page.goto(fixture.origin + "/?join=1");
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await page.evaluate(code => { location.hash = new URLSearchParams({ invite: code }).toString(); }, fixture.joinCode);
      } else {
        await page.goto(`${fixture.origin}/?join=1#${new URLSearchParams({ invite: fixture.joinCode })}`);
      }
      if (mode === "new-member") {
        await page.getByLabel("显示名", { exact: true }).fill("新排练成员");
        await page.getByRole("button", { name: "加入并进入", exact: true }).click();
      }
      await expect(page.getByRole("heading", { name: "本地链路云盘", exact: true })).toBeVisible();
      assert.equal(new URL(page.url()).pathname, `/choirs/${fixture.choirId}`);
      assert.equal(new URL(page.url()).hash === "", true, "invitation fragment must be cleared");
      await expect(page.getByLabel("显示名", { exact: true })).toHaveCount(0);
      await expect(page.locator(".file-row__open")).toHaveCount(1);
      assert.equal(admissions, 1);
    } finally { await context.close(); }
  }
});
