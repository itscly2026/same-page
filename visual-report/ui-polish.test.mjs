import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, webkit, expect } from '@playwright/test';
import { startVisualServer } from './setup.mjs';
import { createVisualFixtureSession } from './fixtures.mjs';

for (const [engineName, engine] of Object.entries({ chromium, webkit })) {
  test(`${engineName}: direct invitations and aligned layer actions fit narrow screens`, async t => {
    const app = await startVisualServer({ script: 'dev' });
    const browser = await engine.launch();
    t.after(async () => { await browser.close(); await app.stop(); });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const fixture = createVisualFixtureSession();
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      const result = fixture.resolve({ pathname, method: request.method(), identity: 'admin', cookie: '' });
      if (pathname.endsWith('/layers') && request.method() === 'GET') {
        const body = JSON.parse(result.body);
        const own = body.layers.find(layer => layer.kind === 'personal');
        body.layers.push({ ...own, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '成员分享的演出笔记', canEdit: false, canShare: false, sharing: true });
        result.body = JSON.stringify(body);
      }
      await route.fulfill(result);
    });
    await mkdir('artifacts/verification/issue-251', { recursive: true });
    await page.goto(`${app.origin}/choirs/visual-choir`);
    await page.locator('.file-row__size').first().waitFor();
    assert.ok((await page.locator('.file-row__size').allTextContents()).every(value => /^\d+ (B|KB|MB)$/.test(value)));
    await page.screenshot({ path: `artifacts/verification/issue-251/${engineName}-library.png` });
    await page.getByRole('button', { name: '打开云盘菜单' }).click();
    await page.getByRole('link', { name: '加入方式', exact: true }).click();
    for (const name of ['复制邀请链接', '复制邀请码', '分享邀请卡', '保存邀请卡']) await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
    await page.screenshot({ path: `artifacts/verification/issue-251/${engineName}-invite.png`, fullPage: true });
    await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
    await page.locator('.pdf-page-canvas [data-pdf-canvas-active]').first().waitFor();
    const viewport = page.locator('.page-reader__viewport');
    const bounds = await viewport.boundingBox();
    await viewport.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    await page.getByRole('button', { name: '看哪些笔记', exact: true }).click();
    await page.getByRole('checkbox', { name: '显示 成员分享的演出笔记' }).waitFor();
    for (const width of [320, 390, 834]) {
      await page.setViewportSize({ width, height: 844 });
      const positions = await page.locator('.layer-row__visibility input').evaluateAll(inputs => inputs.map(input => input.getBoundingClientRect().x));
      assert.ok(positions.length >= 7 && Math.max(...positions) - Math.min(...positions) < 1, `checkbox alignment at ${width}: ${positions}`);
      const panel = page.locator('.reader-layer-panel');
      assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), `panel overflow at ${width}`);
    }
    await page.setViewportSize({ width: 834, height: 1400 });
    await page.screenshot({ path: `artifacts/verification/issue-251/${engineName}-layers-tablet.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `artifacts/verification/issue-251/${engineName}-layers.png` });
    const actions = page.getByRole('group', { name: '我的笔记的操作' });
    await actions.getByRole('button', { name: '重命名', exact: true }).click();
    const input = page.getByRole('textbox', { name: '我的笔记的名称' });
    await expect(input).toBeFocused();
    const inputBounds = await input.boundingBox();
    assert.ok(inputBounds.y >= 0 && inputBounds.y + inputBounds.height <= 844);
    await page.screenshot({ path: `artifacts/verification/issue-251/${engineName}-rename.png` });
    await input.press('Escape');
    await actions.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认删除此层' })).toBeVisible();
    const confirmBounds = await page.getByRole('button', { name: '确认删除', exact: true }).boundingBox();
    assert.ok(confirmBounds.width >= 44 && confirmBounds.height >= 44);
    await page.screenshot({ path: `artifacts/verification/issue-251/${engineName}-delete.png` });
    await page.getByRole('dialog', { name: '确认删除此层' }).getByRole('button', { name: '取消' }).click();
    await expect(actions.getByRole('button', { name: '删除', exact: true })).toBeFocused();
  });
}
