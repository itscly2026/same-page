import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { startStorageFixture } from "./storage-fixture.mjs";

// Real browser IndexedDB + local Worker/D1. The bridge calls product commands;
// it never seeds annotations or mocks API responses. Request holding below delays
// a real response to make editing/identity races deterministic.
test("annotation commands retain offline and in-flight edits with real Worker/D1", { timeout: 120_000 }, async t => {
  const fixture = await startStorageFixture({ authenticated: true, script: "dev" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await fixture.stop(); });
  try {
  const context = await browser.newContext();
  const observer = await browser.newContext();
  const account = fixture.accounts[1];
  for (const client of [context, observer]) {
    const response = await client.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: account.email, password: account.password } });
    assert.equal(response.status(), 200);
  }
  const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
  const page = await context.newPage();
  await page.goto(fixture.origin);
  await page.evaluate(async ({ account, choirId, scoreId, base }) => {
    const state = await import("/src/client/annotations/annotation-state.ts");
    const { AnnotationEditor } = await import("/src/client/annotations/annotation-editor.ts");
    const sync = await import("/src/client/annotations/sync.ts");
    const local = await import("/src/client/platform/local-workspace.ts");
    const { localDatabase: db } = await import("/src/client/platform/local-database.ts");
    await local.activateAuthenticatedLocalOwner(account);
    const workspace = local.createLocalWorkspace(local.authenticatedLocalOwnerKey(account), choirId, scoreId);
    const { layers } = await (await fetch(`${base}/layers`)).json();
    window.annotationTest = { state, sync, local, db, workspace, layers, editor: new AnnotationEditor(workspace) };
  }, { account: account.id, choirId: fixture.choirId, scoreId: fixture.scoreId, base });
  const text = value => ({ kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: value });
  const id = await page.evaluate(() => crypto.randomUUID());
  await context.setOffline(true);
  await page.evaluate(async ({ id, payload }) => {
    const { state, workspace, layers, editor } = window.annotationTest;
    editor.begin();
    await editor.persist({ id, layerId: layers.find(l => l.kind === "personal").id, payload });
    await state.queueScoreDrafts(workspace);
  }, { id, payload: text("offline A") });
  await context.setOffline(false);
  await page.evaluate(async () => { const { sync, workspace } = window.annotationTest; await sync.syncAnnotations(workspace, { pull: true }); });
  const readCloud = async () => (await (await observer.request.get(`${fixture.origin}${base}/annotations`)).json()).objects;
  await expect.poll(async () => (await readCloud()).find(o => o.id === id)?.payload.text).toBe("offline A");

  let release, received;
  const held = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { received = resolve; });
  await page.route("**/annotations/push", async route => {
    const response = await route.fetch(); received(); await held; await route.fulfill({ response });
  });
  await page.evaluate(async ({ id, payload }) => {
    const { state, workspace, layers, editor } = window.annotationTest;
    await editor.persist({ id, layerId: layers.find(l => l.kind === "personal").id, payload });
    await state.queueScoreDrafts(workspace);
    window.pushTask = window.annotationTest.sync.syncAnnotations(workspace, { pull: false });
  }, { id, payload: text("submitted B") });
  await arrived;
  await page.evaluate(async ({ id, payload }) => {
    const { layers, editor } = window.annotationTest;
    await editor.persist({ id, layerId: layers.find(l => l.kind === "personal").id, payload });
    await editor.undo(layers.find(l => l.kind === "personal").id);
    await editor.redo(layers.find(l => l.kind === "personal").id);
  }, { id, payload: text("newer C") });
  release(); await page.evaluate(() => window.pushTask); await page.unroute("**/annotations/push");
  const local = await page.evaluate(async id => {
    const { db, workspace } = window.annotationTest;
    db.close(); await db.open();
    return db.annotations.where("scopeKey").equals(workspace.scopeKey).filter(a => a.id === id).first();
  }, id);
  assert.equal(local.payload.text, "newer C"); assert.equal(local.state, "draft"); assert.equal(local.version, 2);
  await page.evaluate(async () => { const { state, sync, workspace } = window.annotationTest; await state.queueScoreDrafts(workspace); await sync.syncAnnotations(workspace, { pull: true }); });
  await expect.poll(async () => (await readCloud()).find(o => o.id === id)?.payload.text).toBe("newer C");

  // Mixed denied shared layer and allowed personal layer in the same actual batch.
  await page.evaluate(async payload => {
    const { state, sync, workspace, layers } = window.annotationTest;
    for (const layer of [layers.find(l => l.kind === "shared"), layers.find(l => l.kind === "personal")]) {
      await state.saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: layer.id, payload });
    }
    await state.queueScoreDrafts(workspace); await sync.syncAnnotations(workspace, { pull: true });
  }, text("mixed"));
  assert.equal(await page.evaluate(async () => { const { db, workspace } = window.annotationTest; return db.annotations.where("scopeKey").equals(workspace.scopeKey).filter(a => a.syncErrorCode === "permission_denied").count(); }), 1);
  assert.equal((await readCloud()).filter(o => o.payload?.text === "mixed").length, 1);

  const adminContext = await browser.newContext();
  const admin = fixture.accounts[0];
  assert.equal((await adminContext.request.post(`${fixture.origin}/api/auth/sign-in/email`, { headers: { origin: fixture.origin }, data: { email: admin.email, password: admin.password } })).status(), 200);
  const { memberships } = await (await adminContext.request.get(`${fixture.origin}/api/choirs/${fixture.choirId}/memberships`)).json();
  const membership = memberships.find(m => m.role === "member");
  const grantPath = `${fixture.origin}/api/choirs/${fixture.choirId}/shared-layers/E/grants/${membership.id}`;
  assert.equal((await adminContext.request.put(grantPath, { headers: { origin: fixture.origin }, data: { granted: true } })).status(), 200);
  await page.evaluate(async () => { const { state, sync, workspace } = window.annotationTest; await state.retryScoreSyncErrors(workspace); await state.queueScoreDrafts(workspace); await sync.syncAnnotations(workspace, { pull: true }); });
  await expect.poll(async () => (await readCloud()).filter(o => o.payload?.text === "mixed").length).toBe(2);
  // Revoke again so the actual reader can demonstrate the durable blocked state.
  assert.equal((await adminContext.request.put(grantPath, { headers: { origin: fixture.origin }, data: { granted: false } })).status(), 200);
  await page.evaluate(async payload => {
    const { state, sync, workspace, layers } = window.annotationTest;
    await state.saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: layers.find(l => l.sharedSlot === "E").id, payload });
    await state.queueScoreDrafts(workspace); await sync.syncAnnotations(workspace, { pull: true });
  }, text("blocked again"));
  await adminContext.close();

  // A real accepted response arriving after A -> B -> A must be retried, not applied.
  let releaseIdentity, receivedIdentity;
  const identityHeld = new Promise(resolve => { releaseIdentity = resolve; });
  const identityArrived = new Promise(resolve => { receivedIdentity = resolve; });
  await page.route("**/annotations/push", async route => {
    const response = await route.fetch(); receivedIdentity(); await identityHeld; await route.fulfill({ response });
  });
  await page.evaluate(async ({ id, payload }) => {
    const { state, sync, workspace, layers } = window.annotationTest;
    await state.saveAnnotationDraft(workspace, { id, layerId: layers.find(l => l.kind === "personal").id, payload });
    await state.queueScoreDrafts(workspace);
    window.pushTask = sync.syncAnnotations(workspace, { pull: false }).then(() => "applied", error => error.message);
  }, { id, payload: text("identity delayed") });
  await identityArrived;
  await page.evaluate(async ids => {
    const { local } = window.annotationTest;
    await local.activateAuthenticatedLocalOwner(ids[0]);
    await local.activateAuthenticatedLocalOwner(ids[1]);
  }, [fixture.accounts[0].id, account.id]);
  releaseIdentity(); assert.equal(await page.evaluate(() => window.pushTask), "local_workspace_owner_changed");
  await page.unroute("**/annotations/push");
  await page.evaluate(async () => { const { sync, workspace } = window.annotationTest; await sync.syncAnnotations(workspace, { pull: true }); });
  await expect.poll(async () => (await readCloud()).find(o => o.id === id)?.version).toBe(4);
  const holder = await context.newPage();
  await holder.goto(fixture.origin);
  const scopeKey = await page.evaluate(() => window.annotationTest.workspace.scopeKey);
  await holder.evaluate(async scopeKey => {
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    window.heldLock = navigator.locks.request(`same-page:sync:${scopeKey}`, async () => {
      acquired(); await new Promise(resolve => { window.releaseLock = resolve; });
    });
    await ready;
  }, scopeKey);
  assert.equal(await page.evaluate(async () => { const { sync, workspace } = window.annotationTest; return await sync.pushPendingAnnotations(workspace, { maxOperations: 100 }) === undefined; }), true);
  await holder.evaluate(async () => { window.releaseLock(); await window.heldLock; });
  await holder.close();
  await page.goto(`${fixture.origin}/choirs/${fixture.choirId}/scores/${fixture.scoreId}`);
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
  await expect(page.getByRole("complementary", { name: "批注同步异常" })).toContainText("恢复权限后重试");
  await mkdir("artifacts/verification", { recursive: true });
  await page.screenshot({ path: "artifacts/verification/annotations-135.png", fullPage: true });
  } catch (error) { console.error(error); throw error; }

});
