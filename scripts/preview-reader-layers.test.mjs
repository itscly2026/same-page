import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('preview sync returns accepted notes to a fresh reader', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'same-page-preview-'));
  const child = spawn(process.execPath, ['scripts/preview-reader-layers.mjs'], {
    env: { ...process.env, SAME_PAGE_PREVIEW_PORT: '0', SAME_PAGE_PREVIEW_STATE_PATH: join(directory, 'state.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    const stopped = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill(); await stopped; }
    await rm(directory, { recursive: true, force: true });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview did not start')), 15000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/Reader layers preview: (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`preview exited: ${code}`)); });
  });
  const base = `${new URL(url).origin}/api/choirs/visual-choir/scores/visual-score`;
  const initial = await (await fetch(`${base}/sync`)).json();
  const layerId = initial.layers.layers.find(layer => layer.kind === 'personal' && layer.canEdit).id;
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const operation = { opId: crypto.randomUUID(), annotationId: id, layerId, baseVersion: 0, type: 'upsert', payload: { kind: 'text', text: 'preview persistence', pageNumber: 1, x: .2, y: .3, fontScale: .024 } };
  const accepted = await (await fetch(`${base}/annotations/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operations: [operation] }) })).json();
  assert.equal(accepted.results[0].status, 'accepted');
  const fresh = await (await fetch(`${base}/sync?cursor=0&layerIds=[]`)).json();
  assert.equal(fresh.annotations.objects.find(note => note.id === id)?.payload.text, operation.payload.text);
  assert.ok(fresh.annotations.cursor > initial.annotations.cursor);
  assert.equal(fresh.annotations.hasMore, false);
});
