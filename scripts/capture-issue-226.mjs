import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { startViteServer } from './vite-server.mjs';
import { createVisualFixtureSession } from '../visual-report/fixtures.mjs';
const phase = process.argv[2] ?? 'after';
if (!['before', 'after'].includes(phase)) throw new Error('Expected before or after');
if (phase === 'before' && !process.env.ISSUE_226_BASELINE) throw new Error('Set ISSUE_226_BASELINE to the baseline worktree');
const app = await startViteServer({ script: 'dev', cwd: phase === 'before' ? process.env.ISSUE_226_BASELINE ?? process.cwd() : process.cwd() });
const browser = await chromium.launch();
const root = `artifacts/verification/issue-226/${phase}`;
await mkdir(root, { recursive: true });
const evidence = [];
try {
  for (const width of [320, 360, 390, 430, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const fixture = createVisualFixtureSession();
    await context.addInitScript(() => { localStorage.setItem('reader-gesture-hint-seen', 'true'); navigator.serviceWorker.getRegistration = async () => ({ active: {} }); });
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/choirs/visual-choir/settings') return route.fulfill({ json: { name: '示例云盘', nameRevision: 0, displayName: '林老师', membershipRevision: 0, canEditDriveInfo: true } });
      const response = fixture.resolve({ pathname, method: route.request().method(), identity: 'admin', cookie: '' });
      if (pathname.endsWith('/layers')) { const data = JSON.parse(response.body); data.layers = data.layers.map(layer => layer.kind === 'personal' ? { ...layer, canShare: true, sharing: false } : layer); response.body = JSON.stringify(data); }
      return route.fulfill(response);
    });
    const capture = async name => {
      await page.screenshot({ path: `${root}/${width}-${name}.png`, fullPage: true });
      const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
      evidence.push({ width, name, fits });
      if (!fits && phase === 'after') throw new Error(`Overflow: ${width} ${name}`);
    };
    await page.goto(`${app.origin}/#home`);
    await expect(page.getByRole('link', { name: '我的云盘', exact: true })).toBeVisible();
    await capture('home');
    await page.goto(`${app.origin}/choirs/visual-choir`);
    await expect(page.getByRole('button', { name: '上传 PDF', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '打开云盘菜单' }).click();
    await capture('drawer');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '打开云盘菜单' })).toBeFocused();
    await page.getByRole('button', { name: phase === 'before' ? '我的' : '我在此云盘', exact: true }).click();
    if (phase === 'after') await expect(page.getByRole('menuitem', { name: '林老师', exact: true })).toBeVisible();
    await capture('personal-menu');
    await page.keyboard.press('Escape');
    await page.goto(`${app.origin}/choirs/visual-choir/memberships`);
    await expect(page.getByRole('heading', { name: '林老师', exact: true }).first()).toBeVisible();
    await capture('members');
    await page.goto(`${app.origin}/choirs/visual-choir/shared-layers`);
    await expect(page.getByRole(phase === 'before' ? 'button' : 'radio', { name: '当前共享层', exact: true })).toBeVisible();
    await capture('shared-layers');
    await page.goto(`${app.origin}/choirs/visual-choir/storage`);
    await expect(page.getByText('此云盘尚无本机谱面文件。')).toBeVisible();
    await capture('storage-empty');
    await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
    await page.waitForFunction(() => document.querySelector('[data-pdf-canvas-active]')?.width > 100);
    await page.locator('.page-reader__viewport').click();
    await page.getByRole('button', { name: '看哪些笔记', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '显示 Ensemble' })).toBeVisible();
    await page.locator('.layer-section--personal').scrollIntoViewIfNeeded();
    await capture('personal-layers');
    await page.goto(`${app.origin}/choirs/visual-choir/storage`);
    await expect(page.getByRole('link', { name: '排练示例 · 秋日合唱', exact: true })).toBeVisible();
    if (phase === 'after') await expect(page.getByText(/可离线/)).toBeVisible();
    await capture('storage-files');
    await context.close();
  }
} finally {
  await writeFile(`${root}/evidence.json`, JSON.stringify(evidence, null, 2));
  await browser.close(); await app.stop();
}

if (phase === 'after') {
  const titles = { home: '首页', drawer: '云盘抽屉', 'personal-menu': '个人入口', members: '成员与权限', 'shared-layers': '共享层', 'storage-empty': '本机存储 · 空', 'storage-files': '本机存储 · 文件', 'personal-layers': '个人层' };
  await writeFile('artifacts/verification/issue-226/index.html', `<!doctype html><meta charset="utf-8"><title>#226 界面验收</title><style>body{font:16px system-ui;margin:32px;color:#173d44;background:#f5f9f8}summary{cursor:pointer;padding:16px}section{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%;max-height:1100px;object-fit:contain;object-position:top}figure{margin:0}h1{font-size:24px}</style><h1>#226 界面前后对照</h1><p>受控桌面浏览器截图；不代表真实 iPhone/iPad 或生产验收。宽度：320、360、390、430、1440px。</p>${evidence.map(({ width, name, fits }) => `<details><summary>${width}px · ${titles[name]} · ${fits ? '无横向溢出' : '存在溢出'}</summary><section>${['before', 'after'].map(phase => `<figure><figcaption>${phase === 'before' ? '调整前' : '调整后'}</figcaption><a href="${phase}/${width}-${name}.png"><img loading="lazy" src="${phase}/${width}-${name}.png"></a></figure>`).join('')}</section></details>`).join('')}`);
}
