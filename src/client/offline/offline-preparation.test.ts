import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { OfflinePreparation, revokeOfflinePreparationIdentity } from './offline-score';
import { localDatabase } from '../platform/local-database';
import { activateAuthenticatedLocalOwner, createLocalWorkspace, resolveLocalWorkspace } from '../platform/local-workspace';
import { sha256Hex, findVerifiedOfflineScore } from './offline-score-verification';

const clients: OfflinePreparation[] = [];
beforeEach(async () => {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: { getRegistration: async () => ({ active: {} }) } });
  await localDatabase.open();
});
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.unstubAllGlobals(); });
async function fixture(userId: string | null = null) {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: userId, choirId: 'drive', scoreId: 'score' });
  const bytes = new TextEncoder().encode('%PDF-1.7 fixture');
  const score = { id: 'score', choirId: 'drive', fileName: 'sample.pdf', updatedAt: 1, currentVersion: { id: 'v1', versionNumber: 1, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes.buffer), etag: 'v1', pageCount: 1, createdAt: 1 } };
  let finish!: () => void;
  let signal: AbortSignal | null | undefined;
  let downloads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/pdf')) { downloads++; signal = init?.signal; await new Promise<void>(resolve => { finish = resolve; }); return new Response(bytes); }
    if (input.endsWith('/layers')) return Response.json({ layers: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'shared', sharedSlot: 'E', name: 'E', sortOrder: 0, subscribed: true, subscriptionSource: 'product', displayColor: '#a12652', colorSource: 'product', adminDefaultColor: '#a12652', driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: false }], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    if (input.includes('/annotations?')) return Response.json({ cursor: 0, objects: [] });
    return new Response(null, { status: 404 });
  }));
  const client = (target = score, scope = workspace, identity = userId) => { const value = new OfflinePreparation(scope, target, 'pdf', identity); clients.push(value); return value; };
  return { workspace, score, client, finish: () => finish(), signal: () => signal, downloads: () => downloads };
}
it('shares an automatic preparation with explicit intent and completes after both callers leave', async () => {
  const f = await fixture();
  const reader = f.client();
  const automatic = reader.prepare('automatic');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  const list = f.client();
  const explicit = list.prepare('explicit');
  await vi.waitFor(() => expect(list.getSnapshot().phase).toBe('preparing'));
  reader.dispose(); list.dispose();
  expect(f.signal()?.aborted).toBe(false);
  f.finish();
  expect((await explicit).phase).toBe('ready');
  expect((await automatic).phase).toBe('ready');
  expect(f.downloads()).toBe(1);
  expect((await findVerifiedOfflineScore(f.workspace))?.versionId).toBe('v1');
});

it('only cancels when the final automatic requester leaves; an old completion cannot replace a retry', async () => {
  const f = await fixture();
  const first = f.client(), second = f.client();
  const old = first.prepare('automatic');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  const joined = second.prepare('automatic');
  first.dispose();
  expect(f.signal()?.aborted).toBe(false);
  second.dispose();
  expect(f.signal()?.aborted).toBe(true);
  const finishOld = f.finish;
  // Save the first response resolver before starting the retry.
  finishOld();
  expect((await old).phase).toBe('cancelled');
  expect((await joined).phase).toBe('cancelled');
  const retry = f.client();
  const fresh = retry.prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(2));
  expect(retry.getSnapshot().phase).toBe('preparing');
  f.finish();
  expect((await fresh).phase).toBe('ready');
});

it('fences a pending explicit download on file cleanup, but a new explicit request can prepare again', async () => {
  const { clearLocalFiles } = await import('./local-files');
  const f = await fixture();
  const client = f.client();
  const old = client.prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  await clearLocalFiles({ ownerKey: f.workspace.ownerKey, choirId: 'drive', scoreId: 'score' });
  f.finish();
  expect((await old).phase).not.toBe('ready');
  expect(await findVerifiedOfflineScore(f.workspace)).toBeNull();
  const fresh = client.prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(2));
  f.finish();
  expect((await fresh).phase).toBe('ready');
});

it('does not cancel preparations outside the cleaned score', async () => {
  const { clearLocalFiles } = await import('./local-files');
  const f = await fixture();
  const pending = f.client().prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  await clearLocalFiles({ ownerKey: f.workspace.ownerKey, choirId: 'drive', scoreId: 'other' });
  f.finish();
  expect((await pending).phase).toBe('ready');
});

it('rejects remembered user identity and invalidates A to B to A requests', async () => {
  const f = await fixture('a');
  expect((await f.client(f.score, f.workspace, null).prepare('explicit')).phase).toBe('failed');
  expect(f.downloads()).toBe(0);
  const oldClient = f.client();
  const old = oldClient.prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  await activateAuthenticatedLocalOwner('b');
  await activateAuthenticatedLocalOwner('a');
  f.finish();
  expect((await old).phase).not.toBe('ready');
  expect(await findVerifiedOfflineScore(f.workspace)).toBeNull();
  expect((await oldClient.prepare('explicit')).phase).toBe('failed');
});

it('revokes explicit tasks and pending requests when the online identity is lost', async () => {
  const f = await fixture('a');
  const client = f.client();
  const pending = client.prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  revokeOfflinePreparationIdentity('a');
  expect(f.signal()?.aborted).toBe(true);
  f.finish();
  expect((await pending).phase).toBe('cancelled');
  expect((await client.prepare('explicit')).phase).toBe('failed');
});

it('never observes another version or score as the requested copy', async () => {
  const f = await fixture();
  const pending = f.client().prepare('explicit');
  await vi.waitFor(() => expect(f.downloads()).toBe(1));
  const version = f.client({ ...f.score, currentVersion: { ...f.score.currentVersion, id: 'v2' } });
  const other = f.client({ ...f.score, id: 'other' }, createLocalWorkspace(f.workspace.ownerKey, 'drive', 'other'));
  f.finish();
  expect((await pending).phase).toBe('ready');
  expect(version.getSnapshot().phase).toBe('idle');
  expect(other.getSnapshot().phase).toBe('idle');
});
