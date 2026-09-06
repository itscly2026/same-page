import { cleanupSharedLayers } from "./annotations/cleanup";
import { RECOVERY_PERIOD_MS } from "./lifecycle/cleanup";
import type { SharedLayerManagementSummary } from "../src/shared/annotations";
import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import worker from "./index";
import { provisionChoir } from "./choirs/provision";
import { createDatabase } from "./db/database";
import { memberships, user } from "./db/schema";
import { cookieFrom, registerWithPassword } from "./test/auth";

const network = setupNetwork();
let deliveredOtp = "";

beforeAll(() => network.enable());
afterAll(() => network.disable());

beforeEach(async () => {
  deliveredOtp = "";
  network.use(
    http.post("https://api.resend.com/emails", async ({ request }) => {
      const body = (await request.json()) as { text: string };
      deliveredOtp = body.text.match(/验证码：([0-9]{6})/)?.[1] ?? "";
      return HttpResponse.json({ id: crypto.randomUUID() });
    }),
  );
  await env.DB.batch(
    [
      "DELETE FROM annotation_sync_operations",
      "DELETE FROM annotation_objects",
      "DELETE FROM user_score_layer_preferences",
      "DELETE FROM user_drive_layer_preferences",
      "DELETE FROM shared_layer_edit_grants",
      "DELETE FROM annotation_layers",
      "DELETE FROM score_object_deletions",
      "DELETE FROM score_versions",
      "DELETE FROM scores",
      "DELETE FROM memberships",
      "DELETE FROM choirs",
      "DELETE FROM rate_limits",
      "DELETE FROM session",
      "DELETE FROM account",
      "DELETE FROM verification",
      "DELETE FROM user",
    ].map((query) => env.DB.prepare(query)),
  );
});

afterEach(() => network.resetHandlers());

describe("annotation layers and object synchronization", () => {
  it.each(["E", "custom"])("recycles %s across scores, retaining identity, grants and preferences while rejecting stale actions", async slotKind => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "recycle@example.test", "成员");
    const base = `/api/choirs/${fixture.choirId}`;
    const slot = slotKind === "E" ? "E" : (await (await callWorker(`${base}/shared-layers`, jsonRequest(fixture.adminCookie, { name: "伴奏", defaultColor: "#123456" }))).json() as { slot: string }).slot;
    const list = async (state = "current") => (await (await callWorker(`${base}/shared-layers?state=${state}`, { headers: { cookie: fixture.adminCookie } })).json() as { layers: SharedLayerManagementSummary[] }).layers;
    const change = (action: string, expectedRevision: number, cookie = fixture.adminCookie) => callWorker(`${base}/shared-layers/${slot}/lifecycle`, jsonRequest(cookie, { action, expectedRevision }));
    const put = (path: string, body: unknown) => callWorker(`${base}${path}`, { ...jsonRequest(fixture.adminCookie, body), method: "PUT" });
    const members = await (await callWorker(`${base}/shared-layers/${slot}/grants`, { headers: { cookie: fixture.adminCookie } })).json() as { members: { id: string; displayName: string }[] };
    const memberId = members.members.find(row => row.displayName === "成员")!.id;
    await put(`/shared-layers/${slot}/grants/${memberId}`, { granted: true });
    await put(`/shared-layers/${slot}/preference`, { subscribed: false, colorOverride: "#987654" });
    await put(`/scores/${fixture.scoreId}/shared-layers/${slot}/preference`, { subscribed: true });
    const layer = await layerBySlot(fixture, fixture.adminCookie, slot);
    const secondScore = (await (await callWorker(`${base}/scores`, uploadRequest(fixture.adminCookie, "第二首.pdf"))).json() as { score: { id: string } }).score.id;
    const second = { ...fixture, scoreId: secondScore };
    const secondLayer = await layerBySlot(second, fixture.adminCookie, slot);
    const objectId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await push(fixture, [operation(objectId, String(layer!.id), 0, "第一首提示")]);
    await push(second, [operation(secondId, String(secondLayer!.id), 0, "第二首提示")]);
    const original = (await list()).find(row => row.slot === slot)!;
    expect((await change("delete", original.revision, member.cookie)).status).toBe(403);
    expect((await callWorker(`${base}/shared-layers/P/lifecycle`, jsonRequest(fixture.adminCookie, { action: "delete", expectedRevision: 0 }))).status).toBe(409);
    expect((await change("delete", original.revision)).status).toBe(200);
    expect((await change("delete", original.revision)).status).toBe(409);
    expect((await list()).some(row => row.slot === slot)).toBe(false);
    const deleted = (await list("deleted")).find(row => row.slot === slot)!;
    expect(deleted).toMatchObject({ ...original, revision: original.revision + 1, deletedAt: expect.any(Number), recoverUntil: expect.any(Number) });
    expect(deleted.recoverUntil! - deleted.deletedAt!).toBe(RECOVERY_PERIOD_MS);
    expect(await layerBySlot(fixture, member.cookie, slot)).toBeUndefined();
    expect(await layerBySlot(second, fixture.adminCookie, slot)).toBeUndefined();
    expect(await (await push(fixture, [operation(objectId, String(layer!.id), 1, "晚到保存")])).json()).toMatchObject({ results: [{ status: "permission_denied" }] });
    expect((await put(`/shared-layers/${slot}/settings`, { active: true })).status).toBe(404);
    expect((await put(`/shared-layers/${slot}/grants/${memberId}`, { granted: true })).status).toBe(404);
    expect((await put(`/shared-layers/${slot}/order`, { direction: "up" })).status).toBe(404);
    const pullPath = `${base}/scores/${fixture.scoreId}/annotations`;
    expect(await (await callWorker(pullPath, { headers: { cookie: fixture.adminCookie } })).json()).toMatchObject({ objects: [] });
    expect((await change("restore", deleted.revision, member.cookie)).status).toBe(403);
    expect((await change("restore", original.revision)).status).toBe(409);
    expect((await change("restore", deleted.revision)).status).toBe(200);
    await cleanupSharedLayers(env.DB, deleted.recoverUntil! + 1);
    expect(await layerBySlot(fixture, fixture.adminCookie, slot)).toMatchObject({ id: layer!.id, subscribed: true, driveSubscribed: false, driveColorOverride: "#987654" });
    expect(await layerBySlot(fixture, member.cookie, slot)).toMatchObject({ id: layer!.id, canEdit: true });
    expect(await layerBySlot(second, fixture.adminCookie, slot)).toMatchObject({ id: secondLayer!.id });
    expect(await (await callWorker(pullPath, { headers: { cookie: fixture.adminCookie } })).json()).toMatchObject({ objects: [{ id: objectId, version: 1, payload: { text: "第一首提示" } }] });
    const paused = await put(`/shared-layers/${slot}/settings`, { active: false });
    expect(paused.status).toBe(200);
    const beforePauseDelete = (await list()).find(row => row.slot === slot)!;
    await change("delete", beforePauseDelete.revision);
    const pausedDeleted = (await list("deleted")).find(row => row.slot === slot)!;
    await change("restore", pausedDeleted.revision);
    expect((await list()).find(row => row.slot === slot)).toMatchObject({ active: false, sortOrder: original.sortOrder });
    expect(await layerBySlot(fixture, fixture.adminCookie, slot)).toBeUndefined();
    expect(await layerBySlot(fixture, fixture.adminCookie, "S")).toBeDefined();
  });

  it("rejects expired restoration before cleanup, purges atomically and never reuses a same-name slot", async () => {
    const fixture = await createFixture();
    const base = `/api/choirs/${fixture.choirId}`;
    const layer = await layerBySlot(fixture, fixture.adminCookie, "E");
    await push(fixture, [operation(crypto.randomUUID(), String(layer!.id), 0, "将被清理")]);
    await callWorker(`${base}/shared-layers/E/lifecycle`, jsonRequest(fixture.adminCookie, { action: "delete", expectedRevision: 0 }));
    const expiredAt = Date.now() - RECOVERY_PERIOD_MS - 1;
    await env.DB.prepare("UPDATE choir_shared_layer_settings SET deleted_at = ? WHERE choir_id = ? AND slot = 'E'").bind(expiredAt, fixture.choirId).run();
    expect((await callWorker(`${base}/shared-layers/E/lifecycle`, jsonRequest(fixture.adminCookie, { action: "restore", expectedRevision: 1 }))).status).toBe(409);
    await cleanupSharedLayers(env.DB);
    await cleanupSharedLayers(env.DB);
    const list = await (await callWorker(`${base}/shared-layers?state=deleted`, { headers: { cookie: fixture.adminCookie } })).json();
    expect(list).toMatchObject({ layers: [] });
    for (const table of ["annotation_layers", "annotation_objects", "annotation_sync_operations", "shared_layer_edit_grants", "user_drive_layer_preferences", "user_score_layer_preferences"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE choir_id = ?`).bind(fixture.choirId).first()).toEqual({ count: table === "annotation_layers" ? 5 : 0 });
    }
    const created = await (await callWorker(`${base}/shared-layers`, jsonRequest(fixture.adminCookie, { name: "Ensemble", defaultColor: "#123456" }))).json() as { slot: string };
    expect(created.slot).not.toBe("E");
    expect(await (await push(fixture, [operation(crypto.randomUUID(), String(layer!.id), 0, "旧设备草稿")])).json()).toMatchObject({ results: [{ status: "permission_denied" }] });
    expect(await layerBySlot(fixture, fixture.adminCookie, created.slot)).toBeDefined();
  });

  it("moves a shared layer one position atomically and denies non-admin reordering", async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "order-member@example.test", "成员");
    const base = `/api/choirs/${fixture.choirId}/shared-layers`;
    const move = (cookie: string, slot: string, direction: string) => callWorker(`${base}/${slot}/order`, { ...jsonRequest(cookie, { direction }), method: "PUT" });
    expect((await move(member.cookie, "T", "up")).status).toBe(403);
    expect((await move(fixture.adminCookie, "T", "up")).status).toBe(200);
    const response = await callWorker(base, { headers: { cookie: fixture.adminCookie } });
    const body = await response.json() as { layers: { slot: string }[] };
    expect(body.layers.map(layer => layer.slot)).toEqual(["E", "S", "T", "A", "B"]);
    expect((await move(fixture.adminCookie, "E", "up")).status).toBe(200);
    expect((await move(fixture.adminCookie, "missing", "down")).status).toBe(404);
  });

  it("configures a stable shared layer across existing and future scores and pauses its writes", async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "custom-member@example.test", "成员");
    const base = `/api/choirs/${fixture.choirId}`;
    expect((await callWorker(`${base}/shared-layers`, jsonRequest(member.cookie, { name: "钢琴", defaultColor: "#123456" }))).status).toBe(403);
    const created = await callWorker(`${base}/shared-layers`, jsonRequest(fixture.adminCookie, { name: "钢琴", defaultColor: "#123456" }));
    expect(created.status).toBe(201);
    const { slot } = await created.json() as { slot: string };
    const layer = await layerBySlot(fixture, fixture.adminCookie, slot);
    expect(layer).toMatchObject({ name: "钢琴", canEdit: true });
    const objectId = crypto.randomUUID();
    expect(await (await push(fixture, [operation(objectId, String(layer!.id), 0, "伴奏提示")])).json()).toMatchObject({ results: [{ status: "accepted" }] });
    expect((await callWorker(`${base}/shared-layers/${slot}/settings`, { ...jsonRequest(fixture.adminCookie, { name: "钢琴伴奏", sortOrder: 0 }), method: "PUT" })).status).toBe(200);
    expect(await layerBySlot(fixture, member.cookie, slot)).toMatchObject({ id: layer!.id, name: "钢琴伴奏", sortOrder: 0, canEdit: false });
    const upload = await callWorker(`${base}/scores`, uploadRequest(fixture.adminCookie, "另一首.pdf"));
    const { score } = await upload.json() as { score: { id: string } };
    expect(await layerBySlot({ ...fixture, scoreId: score.id }, member.cookie, slot)).toMatchObject({ name: "钢琴伴奏" });
    expect((await callWorker(`${base}/shared-layers/${slot}/settings`, { ...jsonRequest(fixture.adminCookie, { active: false }), method: "PUT" })).status).toBe(200);
    expect(await layerBySlot(fixture, fixture.adminCookie, slot)).toBeUndefined();
    expect(await (await push(fixture, [operation(objectId, String(layer!.id), 1, "暂停时禁止写入")])).json()).toMatchObject({ results: [{ status: "permission_denied" }] });
    await callWorker(`${base}/shared-layers/${slot}/settings`, { ...jsonRequest(fixture.adminCookie, { active: true }), method: "PUT" });
    expect(await layerBySlot(fixture, fixture.adminCookie, slot)).toMatchObject({ id: layer!.id });
    const pull = await callWorker(`${base}/scores/${fixture.scoreId}/annotations`, { headers: { cookie: member.cookie } });
    expect(await pull.json()).toMatchObject({ objects: [expect.objectContaining({ id: objectId, payload: expect.objectContaining({ text: "伴奏提示" }) })] });
  });

  it("shares only one score's personal notes with members, keeps author-only editing, and revokes access", async () => {
    const fixture = await createFixture();
    const author = await createMember(fixture.joinCode!, "author@example.test", "声部长");
    const reader = await createMember(fixture.joinCode!, "reader@example.test", "读者");
    const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
    const list = async (cookie: string, path = base) => {
      const response = await callWorker(`${path}/layers`, { headers: { cookie } });
      return (await response.json() as { layers: Array<{ id: string; kind: string; canEdit: boolean; sharing: boolean; subscribed: boolean }> }).layers;
    };
    const personal = (await list(author.cookie)).find(layer => layer.kind === "personal")!;
    const authorFixture = { ...fixture, adminCookie: author.cookie, adminUserId: author.userId };
    const objectId = crypto.randomUUID();
    await push(authorFixture, [operation(objectId, personal.id, 0, "我的排练笔记")]);
    expect((await list(reader.cookie)).some(layer => layer.id === personal.id)).toBe(false);
    const share = (sharing: boolean) => callWorker(`${base}/personal-layer/sharing`, { ...jsonRequest(author.cookie, { sharing }), method: "PUT" });
    expect((await share(true)).status).toBe(200);
    for (const cookie of [reader.cookie, fixture.adminCookie]) {
      expect((await list(cookie)).find(layer => layer.id === personal.id)).toMatchObject({ sharing: true, subscribed: false, canEdit: false });
    }
    const subscribe = await callWorker(`${base}/personal-layers/${personal.id}/subscription`, { ...jsonRequest(reader.cookie, { subscribed: true }), method: "PUT" });
    expect(subscribe.status).toBe(200);
    expect((await list(reader.cookie)).find(layer => layer.id === personal.id)).toMatchObject({ subscribed: true });
    for (const actor of [fixture, { ...fixture, adminCookie: reader.cookie, adminUserId: reader.userId }]) {
      expect(await (await push(actor, [operation(objectId, personal.id, 1, "不能修改")])).json()).toMatchObject({ results: [{ status: "permission_denied" }] });
    }
    const pull = async (cookie: string) => (await callWorker(`${base}/annotations`, { headers: { cookie } })).json();
    expect(await pull(reader.cookie)).toMatchObject({ objects: [expect.objectContaining({ id: objectId })] });
    await push(authorFixture, [operation(objectId, personal.id, 1, "更新后的笔记")]);
    expect(await pull(reader.cookie)).toMatchObject({ objects: [expect.objectContaining({ version: 2, payload: expect.objectContaining({ text: "更新后的笔记" }) })] });
    const guest = await createGuestCookie(fixture.joinCode!);
    expect((await list(guest)).some(layer => layer.id === personal.id)).toBe(false);
    expect(await pull(guest)).toMatchObject({ objects: [] });
    const upload = await callWorker(`/api/choirs/${fixture.choirId}/scores`, uploadRequest(fixture.adminCookie, "未分享.pdf"));
    const { score } = await upload.json() as { score: { id: string } };
    const otherPersonal = (await list(author.cookie, `/api/choirs/${fixture.choirId}/scores/${score.id}`)).find(layer => layer.kind === "personal")!;
    expect(otherPersonal.sharing).toBe(false);
    expect((await share(false)).status).toBe(200);
    expect((await list(reader.cookie)).some(layer => layer.id === personal.id)).toBe(false);
    expect(await pull(reader.cookie)).toMatchObject({ objects: [] });
    await share(true);
    expect((await list(reader.cookie)).find(layer => layer.id === personal.id)).toMatchObject({ subscribed: false });
    const membersResponse = await callWorker(`/api/choirs/${fixture.choirId}/shared-layers/E/grants`, { headers: { cookie: fixture.adminCookie } });
    const { members } = await membersResponse.json() as { members: Array<{ id: string; displayName: string }> };
    const authorMembership = members.find(member => member.displayName === "声部长")!;
    await callWorker(`/api/choirs/${fixture.choirId}/memberships/${authorMembership.id}`, jsonRequest(fixture.adminCookie, { action: "remove", expectedRevision: 0 }));
    expect(await pull(reader.cookie)).toMatchObject({ objects: [] });
  });

  it.each(["target", "actor"])("rejects a delayed grant across %s membership changes", async (changed) => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "grant-target@example.test", "成员");
    const target = await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, member.userId) });
    const actor = await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, fixture.adminUserId) });
    if (changed === "actor") {
      expect((await callWorker(`/api/choirs/${fixture.choirId}/memberships/${target!.id}`, jsonRequest(fixture.adminCookie, { action: "promote", expectedRevision: 0 }))).status).toBe(204);
    }
    const another = changed === "actor" ? await createMember(fixture.joinCode!, "grant-another@example.test", "另一成员") : null;
    const grantTarget = another ? await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, another.userId) }) : target;
    const DB = new Proxy(env.DB, { get(db, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        const membershipId = changed === "target" ? target!.id : actor!.id;
        const adminCookie = changed === "target" ? fixture.adminCookie : member.cookie;
        const path = `/api/choirs/${fixture.choirId}/memberships/${membershipId}`;
        expect((await callWorker(path, jsonRequest(adminCookie, { action: "remove", expectedRevision: 0 }))).status).toBe(204);
        expect((await callWorker(path, jsonRequest(adminCookie, { action: "restore", expectedRevision: 1 }))).status).toBe(204);
        return db.batch(statements);
      };
      const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
    }});
    const execution = createExecutionContext();
    const response = await worker.fetch(new Request(`https://same-page.test/api/choirs/${fixture.choirId}/shared-layers/E/grants/${grantTarget!.id}`, { ...jsonRequest(fixture.adminCookie, { granted: true }), method: "PUT" }), { ...env, DB }, execution);
    await waitOnExecutionContext(execution);
    expect(response.status).toBe(409);
    const grants = await callWorker(`/api/choirs/${fixture.choirId}/shared-layers/E/grants`, { headers: { cookie: changed === "target" ? fixture.adminCookie : member.cookie } });
    expect(await grants.json()).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ id: grantTarget!.id, role: "member", granted: false })]) });
  });

  it("measures real local D1 batches of 1 and 100 mixed operations", async () => {
    const fixture = await createFixture();
    const layersResponse = await callWorker(`/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/layers`, { headers: { cookie: fixture.adminCookie } });
    const { layers } = await layersResponse.json() as { layers: Array<{ id: string; kind: string }> };
    const personal = layers.find(layer => layer.kind === "personal")!;
    const measurements: Array<{ size: number; sql: number; roundTrips: number }> = [];
    for (const size of [1, 100]) {
      let sql = 0, roundTrips = 0;
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(target, key) {
          if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => { sql++; roundTrips++; return value.apply(target, args); };
        },
      });
      const DB = new Proxy(env.DB, { get(target, key) {
        if (key === "prepare") return (query: string) => wrap(target.prepare(query));
        if (key === "batch") return (statements: D1PreparedStatement[]) => { sql += statements.length; roundTrips++; return target.batch(statements); };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      }});
      const operations = Array.from({ length: size }, (_, i) => operation(crypto.randomUUID(), i % 2 ? personal.id : fixture.layerId, 0, "benchmark"));
      const execution = createExecutionContext();
      const response = await worker.fetch(new Request(`https://same-page.test/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations/push`, jsonRequest(fixture.adminCookie, { operations }, { "x-same-page-owner-user-id": fixture.adminUserId })), { ...env, DB }, execution);
      await waitOnExecutionContext(execution);
      expect(response.status).toBe(200);
      const body = await response.json() as { results: Array<{ status: string }> };
      expect(body.results).toHaveLength(size);
      expect(body.results.every(result => result.status === "accepted")).toBe(true);
      measurements.push({ size, sql, roundTrips });
    }
    // Catch per-object SQL/transport regressions without freezing the query plan.
    expect(measurements[1].sql).toBeLessThanOrEqual(measurements[0].sql + 1);
    expect(measurements[1].roundTrips).toBeLessThanOrEqual(measurements[0].roundTrips + 1);
  });

  it("lets signed-in preview users sync only their own personal layer without joining", async () => {
    const fixture = await createFixture();
    await env.DB.prepare("UPDATE choirs SET guest_admission_mode = 'open', is_preview_entry = 1, join_code_hash = NULL, join_code_ciphertext = NULL WHERE id = ?")
      .bind(fixture.choirId).run();
    const first = await signIn("preview-first@example.test");
    const second = await signIn("preview-second@example.test");
    const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
    const read = (path: string, cookie: string) => callWorker(path, { headers: { cookie } });
    const bootstrap = await read(`/api/choirs/${fixture.choirId}/bootstrap`, first.cookie);
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      scores: [{ id: fixture.scoreId }], permissions: { canManage: false, access: "preview" },
    });
    const layers = await read(`${base}/layers`, first.cookie);
    expect(layers.status).toBe(200);
    const body = await layers.json() as { layers: Array<{ id: string; kind: string; canEdit: boolean }> };
    const personal = body.layers.find((layer) => layer.kind === "personal")!;
    expect(personal.canEdit).toBe(true);
    expect(body.layers.filter((layer) => layer.kind === "shared").every((layer) => !layer.canEdit)).toBe(true);
    const author = { ...fixture, adminCookie: first.cookie, adminUserId: first.userId };
    const op = operation(crypto.randomUUID(), personal.id, 0, "只属于我");
    expect(await (await push(author, [op])).json()).toMatchObject({ results: [{ status: "accepted" }] });
    // Reloading the layers and pulling from a fresh request retains the same private content.
    expect(await (await read(`${base}/layers`, first.cookie)).json()).toMatchObject({
      layers: expect.arrayContaining([expect.objectContaining({ id: personal.id })]),
    });
    expect(await (await read(`${base}/annotations`, first.cookie)).json()).toMatchObject({
      objects: [expect.objectContaining({ id: op.annotationId, payload: expect.objectContaining({ text: "只属于我" }) })],
    });
    for (const other of [second, { cookie: fixture.adminCookie, userId: fixture.adminUserId }]) {
      expect(await (await read(`${base}/layers`, other.cookie)).json()).not.toMatchObject({
        layers: expect.arrayContaining([expect.objectContaining({ id: personal.id })]),
      });
      expect(await (await read(`${base}/annotations`, other.cookie)).json()).toMatchObject({ objects: [] });
      expect(await (await push({ ...fixture, adminCookie: other.cookie, adminUserId: other.userId }, [
        operation(op.annotationId, personal.id, 1, "不能改别人的"),
      ])).json()).toMatchObject({ results: [{ status: "permission_denied" }] });
    }
    expect(await (await push(author, [operation(crypto.randomUUID(), fixture.layerId, 0, "不能改共享层")])).json()).toMatchObject({ results: [{ status: "permission_denied" }] });
    expect((await callWorker(`/api/choirs/${fixture.choirId}/scores`, uploadRequest(first.cookie, "禁止上传.pdf"))).status).toBe(403);
    const guestResponse = await callWorker("/api/guest/session", jsonRequest("", { admission: "open", choirId: fixture.choirId }));
    const guestCookie = cookieFrom(guestResponse);
    const guestLayers = await (await read(`${base}/layers`, guestCookie)).json() as typeof body;
    expect(guestLayers.layers.every((layer) => layer.kind === "shared" && !layer.canEdit)).toBe(true);
    expect((await push({ ...fixture, adminCookie: guestCookie }, [op])).status).toBe(401);
    expect(await (await read(`${base}/annotations`, guestCookie)).json()).toMatchObject({ objects: [] });
    const updated = operation(op.annotationId, personal.id, 1, "修改后");
    expect(await (await push(author, [updated])).json()).toMatchObject({ results: [{ status: "accepted", object: { version: 2 } }] });
    expect(await (await push(author, [{ ...updated, opId: crypto.randomUUID(), baseVersion: 2, type: "delete", payload: null }])).json())
      .toMatchObject({ results: [{ status: "accepted", object: { deleted: true } }] });
    const memberCount = await env.DB.prepare("SELECT COUNT(*) AS total FROM memberships WHERE choir_id = ?").bind(fixture.choirId).first<{ total: number }>();
    expect(memberCount?.total).toBe(1);
    // An ordinary open drive still requires membership for private editing.
    await env.DB.prepare("UPDATE choirs SET is_preview_entry = 0 WHERE id = ?").bind(fixture.choirId).run();
    expect((await read(`${base}/layers`, first.cookie)).status).toBe(403);
  });

  it("lets only administrators retrieve, restore and rotate the current invite code", async () => {
    const fixture = await createFixture();
    const outsider = await signIn("invite-outsider@example.test");
    const endpoint = `/api/choirs/${fixture.choirId}/join-code`;
    const read = (cookie: string) => callWorker(endpoint, { headers: { cookie } });
    const current = await read(fixture.adminCookie);
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("no-store");
    expect(await current.json()).toEqual({ joinCode: fixture.joinCode });
    expect((await read(outsider.cookie)).status).toBe(403);
    expect((await read("")).status).toBe(403);
    const before = await env.DB.prepare("SELECT join_code_ciphertext AS ciphertext, guest_session_version AS version FROM choirs WHERE id = ?")
      .bind(fixture.choirId).first<{ ciphertext: string; version: number }>();
    expect(before?.ciphertext).not.toContain(fixture.joinCode);
    await env.DB.prepare("UPDATE choirs SET join_code_ciphertext = NULL WHERE id = ?").bind(fixture.choirId).run();
    expect(await (await read(fixture.adminCookie)).json()).toEqual({ joinCode: null });
    const restore = (cookie: string, code: string) => callWorker(endpoint, { ...jsonRequest(cookie, { joinCode: code }), method: "PUT" });
    expect((await restore(outsider.cookie, fixture.joinCode!)).status).toBe(403);
    const wrongCode = fixture.joinCode === "ABCDEFGH" ? "HGFEDCBA" : "ABCDEFGH";
    expect((await restore(fixture.adminCookie, wrongCode)).status).toBe(409);
    expect((await restore(fixture.adminCookie, fixture.joinCode!)).status).toBe(204);
    expect(await (await read(fixture.adminCookie)).json()).toEqual({ joinCode: fixture.joinCode });
    const restored = await env.DB.prepare("SELECT guest_session_version AS version FROM choirs WHERE id = ?").bind(fixture.choirId).first<{ version: number }>();
    expect(restored?.version).toBe(before?.version);
    const rotated = await callWorker(`${endpoint}/rotate`, { method: "POST", headers: { cookie: fixture.adminCookie } });
    expect(rotated.status).toBe(200);
    const newCode = await rotated.json() as { joinCode: string };
    expect(await (await read(fixture.adminCookie)).json()).toEqual(newCode);
    expect((await restore(fixture.adminCookie, fixture.joinCode!)).status).toBe(409);
    const oldAdmission = await callWorker("/api/guest/session", jsonRequest("", { admission: "invite", joinCode: fixture.joinCode }));
    expect(oldAdmission.status).toBe(401);
    const newAdmission = await callWorker("/api/guest/session", jsonRequest("", { admission: "invite", joinCode: newCode.joinCode }));
    expect(newAdmission.status).toBe(200);
  });

  it("merges independent objects, conflicts only the stale object, and retries opId idempotently", async () => {
    const fixture = await createFixture();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const createFirst = operation(firstId, fixture.layerId, 0, "第一处");
    const createSecond = operation(secondId, fixture.layerId, 0, "第二处");

    const switchedOwner = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations/push`,
      jsonRequest(
        fixture.adminCookie,
        { operations: [createFirst] },
        { "x-same-page-owner-user-id": crypto.randomUUID() },
      ),
    );
    expect(switchedOwner.status).toBe(409);
    expect(await switchedOwner.json()).toEqual({
      error: "local_workspace_owner_changed",
    });

    const createResponse = await push(fixture, [createFirst, createSecond]);
    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toMatchObject({
      results: [
        { opId: createFirst.opId, status: "accepted", object: { version: 1 } },
        { opId: createSecond.opId, status: "accepted", object: { version: 1 } },
      ],
    });

    const legacyId = crypto.randomUUID();
    const legacyOperation = {
      opId: crypto.randomUUID(),
      annotationId: legacyId,
      layerId: fixture.layerId,
      baseVersion: 0,
      type: "upsert" as const,
      payload: {
        kind: "text" as const,
        pageNumber: 1,
        x: 0.2,
        y: 0.3,
        text: "迁移窗口旧客户端",
      },
    };
    const legacyResponse = await push(fixture, [legacyOperation]);
    expect(await legacyResponse.json()).toMatchObject({
      results: [
        {
          opId: legacyOperation.opId,
          status: "accepted",
          object: { payload: { text: "迁移窗口旧客户端", fontScale: 0.024 } },
        },
      ],
    });

    const winning = operation(firstId, fixture.layerId, 1, "云端先接受");
    const stale = operation(firstId, fixture.layerId, 1, "本机冲突");
    const independent = operation(secondId, fixture.layerId, 1, "另一对象照常成功");
    const mixedResponse = await push(fixture, [winning, stale, independent]);
    expect(await mixedResponse.json()).toMatchObject({
      results: [
        { status: "accepted", object: { version: 2 } },
        {
          status: "conflict",
          object: {
            version: 2,
            payload: { text: "云端先接受", fontScale: 0.024 },
          },
        },
        {
          status: "accepted",
          object: {
            version: 2,
            payload: { text: "另一对象照常成功", fontScale: 0.024 },
          },
        },
      ],
    });

    const retry = await push(fixture, [winning]);
    expect(await retry.json()).toMatchObject({
      results: [{ opId: winning.opId, status: "accepted", object: { version: 2 } }],
    });
    const legacyPayloadHash = await sha256(
      `upsert:${JSON.stringify({
        pageNumber: 1,
        kind: "text",
        x: 0.2,
        y: 0.3,
        text: "云端先接受",
      })}`,
    );
    await env.DB.prepare(
      "UPDATE annotation_sync_operations SET payload_hash = ? WHERE op_id = ?",
    )
      .bind(legacyPayloadHash, winning.opId)
      .run();
    const migratedRetry = await push(fixture, [winning]);
    expect(await migratedRetry.json()).toMatchObject({
      results: [{ opId: winning.opId, status: "accepted", object: { version: 2 } }],
    });
    const changedReuse = await push(fixture, [
      { ...winning, payload: { ...winning.payload, text: "不是同一操作" } },
    ]);
    expect(await changedReuse.json()).toEqual({
      results: [{ opId: winning.opId, status: "op_id_reused" }],
    });
    await env.DB.prepare(
      "UPDATE annotation_objects SET payload_json = json_remove(payload_json, '$.fontScale') WHERE id = ?",
    )
      .bind(legacyId)
      .run();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM annotation_sync_operations WHERE op_id = ?",
      )
        .bind(winning.opId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT payload_json FROM annotation_sync_operations WHERE op_id = ?",
      )
        .bind(stale.opId)
        .first(),
    ).toEqual({ payload_json: null });
    const conflictRetry = await push(fixture, [stale]);
    expect(await conflictRetry.json()).toMatchObject({
      results: [
        {
          opId: stale.opId,
          status: "conflict",
          object: {
            version: 2,
            payload: { text: "云端先接受", fontScale: 0.024 },
          },
        },
      ],
    });

    const pull = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations?cursor=0`,
      { headers: { cookie: fixture.adminCookie } },
    );
    const pulled = (await pull.json()) as {
      cursor: number;
      objects: Array<{
        id: string;
        version: number;
        payload: { text: string; fontScale: number };
      }>;
    };
    expect(pulled.cursor).toBeGreaterThan(0);
    expect(pulled.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstId,
          version: 2,
          payload: expect.objectContaining({ text: "云端先接受", fontScale: 0.024 }),
        }),
        expect.objectContaining({
          id: secondId,
          version: 2,
          payload: expect.objectContaining({ text: "另一对象照常成功", fontScale: 0.024 }),
        }),
        expect.objectContaining({
          id: legacyId,
          version: 1,
          payload: expect.objectContaining({
            text: "迁移窗口旧客户端",
            fontScale: 0.024,
          }),
        }),
      ]),
    );
  });

  it("rejects a version-zero delete while preserving positive-version OCC", async () => {
    const fixture = await createFixture();
    const annotationId = crypto.randomUUID();
    const impossibleDelete = {
      opId: crypto.randomUUID(),
      annotationId,
      layerId: fixture.layerId,
      baseVersion: 0,
      type: "delete" as const,
      payload: null,
    };
    expect(await (await push(fixture, [impossibleDelete])).json()).toEqual({
      results: [
        {
          opId: impossibleDelete.opId,
          status: "conflict",
          object: null,
        },
      ],
    });

    const create = operation(annotationId, fixture.layerId, 0, "待删除");
    expect(await (await push(fixture, [create])).json()).toMatchObject({
      results: [{ status: "accepted", object: { version: 1 } }],
    });
    const validDelete = {
      ...impossibleDelete,
      opId: crypto.randomUUID(),
      baseVersion: 1,
    };
    expect(await (await push(fixture, [validDelete])).json()).toMatchObject({
      results: [
        {
          status: "accepted",
          object: { version: 2, deleted: true, payload: null },
        },
      ],
    });
    const staleDelete = { ...validDelete, opId: crypto.randomUUID() };
    expect(await (await push(fixture, [staleDelete])).json()).toMatchObject({
      results: [
        {
          status: "conflict",
          object: { version: 2, deleted: true },
        },
      ],
    });
  });

  it("allows only the operation that atomically claimed a concurrently reused opId", async () => {
    const fixture = await createFixture();
    const first = operation(
      crypto.randomUUID(),
      fixture.layerId,
      0,
      "并发操作甲",
    );
    const second = {
      ...operation(crypto.randomUUID(), fixture.layerId, 0, "并发操作乙"),
      opId: first.opId,
    };
    const responses = await Promise.all([
      push(fixture, [first]),
      push(fixture, [second]),
    ]);
    const statuses = await Promise.all(
      responses.map(async (response) => {
        const body = (await response.json()) as {
          results: Array<{ status: string }>;
        };
        return body.results[0]?.status;
      }),
    );
    expect(statuses.sort()).toEqual(["accepted", "op_id_reused"]);

    const operationRow = await env.DB.prepare(
      "SELECT annotation_id FROM annotation_sync_operations WHERE op_id = ?",
    )
      .bind(first.opId)
      .first<{ annotation_id: string }>();
    const objects = await env.DB.prepare(
      "SELECT id FROM annotation_objects WHERE id IN (?, ?)",
    )
      .bind(first.annotationId, second.annotationId)
      .all<{ id: string }>();
    expect(objects.results).toHaveLength(1);
    expect(objects.results[0]?.id).toBe(operationRow?.annotation_id);
  });

  it("resolves score subscriptions over user drive defaults without score colors", async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "preference@example.test", "小周");
    const drivePath = `/api/choirs/${fixture.choirId}/shared-layers/E/preference`;
    const scorePath = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/shared-layers/E/preference`;

    expect((await callWorker(drivePath, {
      ...jsonRequest(member.cookie, { subscribed: false, colorOverride: "#112233" }),
      method: "PUT",
    })).status).toBe(200);
    expect((await callWorker(scorePath, {
      ...jsonRequest(member.cookie, { colorOverride: "#445566" }),
      method: "PUT",
    })).status).toBe(400);
    expect((await callWorker(scorePath, {
      ...jsonRequest(member.cookie, { subscribed: true }),
      method: "PUT",
    })).status).toBe(200);

    const customized = await layerBySlot(fixture, member.cookie, "E");
    expect(customized).toMatchObject({
      subscribed: true,
      subscriptionSource: "score",
      displayColor: "#112233",
      colorSource: "drive",
      driveSubscribed: false,
      scoreSubscriptionOverride: true,
    });

    expect((await callWorker(scorePath, {
      ...jsonRequest(member.cookie, { subscribed: null }),
      method: "PUT",
    })).status).toBe(200);
    expect((await callWorker(drivePath, {
      ...jsonRequest(member.cookie, { colorOverride: null }),
      method: "PUT",
    })).status).toBe(200);
    expect((await callWorker(
      `/api/choirs/${fixture.choirId}/shared-layers/E/settings`,
      {
        ...jsonRequest(fixture.adminCookie, { defaultColor: "#abcdef" }),
        method: "PUT",
      },
    )).status).toBe(200);

    expect(await layerBySlot(fixture, member.cookie, "E")).toMatchObject({
      subscribed: false,
      subscriptionSource: "drive",
      displayColor: "#abcdef",
      colorSource: "admin",
      scoreSubscriptionOverride: null,
    });
  });

  it("lists drive-scoped personal preferences and administrator layer summaries", async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "settings@example.test", "小林");
    const preferencePath = `/api/choirs/${fixture.choirId}/shared-layer-preferences`;
    const managementPath = `/api/choirs/${fixture.choirId}/shared-layers`;

    const preferences = await callWorker(preferencePath, {
      headers: { cookie: member.cookie },
    });
    expect(preferences.status).toBe(200);
    expect(await preferences.json()).toMatchObject({
      drive: { id: fixture.choirId, name: "小红花云盘" },
      layers: expect.arrayContaining([
        {
          slot: "E",
          name: "Ensemble",
          subscribed: true,
          colorOverride: null,
          adminDefaultColor: "#a12652",
          displayColor: "#a12652",
          colorSource: "admin",
        },
      ]),
    });

    expect((await callWorker(managementPath, {
      headers: { cookie: member.cookie },
    })).status).toBe(403);
    const management = await callWorker(managementPath, {
      headers: { cookie: fixture.adminCookie },
    });
    expect(management.status).toBe(200);
    expect(await management.json()).toMatchObject({
      drive: { id: fixture.choirId, name: "小红花云盘" },
      layers: expect.arrayContaining([
        {
          slot: "E",
          name: "Ensemble",
          defaultColor: "#a12652",
          grantedMemberCount: 0,
          sortOrder: 0, active: true, revision: 0, deletedAt: null, recoverUntil: null,
        },
      ]),
    });

    const memberRow = await createDatabase(env.DB).query.memberships.findFirst({
      where: eq(memberships.userId, member.userId),
    });
    const grantPath = `/api/choirs/${fixture.choirId}/shared-layers/E/grants/${memberRow!.id}`;
    expect((await callWorker(grantPath, {
      ...jsonRequest(fixture.adminCookie, { granted: true }),
      method: "PUT",
    })).status).toBe(200);
    const grantedManagement = await callWorker(managementPath, {
      headers: { cookie: fixture.adminCookie },
    });
    expect(((await grantedManagement.json()) as {
      layers: Array<{ slot: string; grantedMemberCount: number }>;
    }).layers.find((layer) => layer.slot === "E")?.grantedMemberCount).toBe(1);

    await env.DB.prepare("UPDATE memberships SET status = 'removed' WHERE id = ?")
      .bind(memberRow!.id)
      .run();
    const removedManagement = await callWorker(managementPath, {
      headers: { cookie: fixture.adminCookie },
    });
    expect(((await removedManagement.json()) as {
      layers: Array<{ slot: string; grantedMemberCount: number }>;
    }).layers.find((layer) => layer.slot === "E")?.grantedMemberCount).toBe(0);
  });

  it("enforces revoked grants, choir boundaries, personal privacy and guest read-only access", async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "member@example.test", "小王");
    const memberRow = await createDatabase(env.DB).query.memberships.findFirst({
      where: eq(memberships.userId, member.userId),
    });
    const grantPath = `/api/choirs/${fixture.choirId}/shared-layers/E/grants/${memberRow!.id}`;
    const grant = await callWorker(
      grantPath,
      { ...jsonRequest(fixture.adminCookie, { granted: true }), method: "PUT" },
    );
    expect(grant.status).toBe(200);

    const accepted = await push(
      { ...fixture, adminCookie: member.cookie, adminUserId: member.userId },
      [operation(crypto.randomUUID(), fixture.layerId, 0, "获授权")],
    );
    expect(accepted.status).toBe(200);
    const revoke = await callWorker(
      grantPath,
      { ...jsonRequest(fixture.adminCookie, { granted: false }), method: "PUT" },
    );
    expect(revoke.status).toBe(200);
    const revoked = await push(
      { ...fixture, adminCookie: member.cookie, adminUserId: member.userId },
      [operation(crypto.randomUUID(), fixture.layerId, 0, "已撤权")],
    );
    expect(await revoked.json()).toMatchObject({ results: [{ status: "permission_denied" }] });

    const memberLayers = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/layers`,
      { headers: { cookie: member.cookie } },
    );
    const memberLayerBody = (await memberLayers.json()) as {
      layers: Array<{ id: string; kind: string }>;
    };
    const memberPersonal = memberLayerBody.layers.find((layer) => layer.kind === "personal")!;
    const mixed = await push({ ...fixture, adminCookie: member.cookie, adminUserId: member.userId }, [
      operation(crypto.randomUUID(), fixture.layerId, 0, "失权草稿"),
      operation(crypto.randomUUID(), memberPersonal.id, 0, "合法个人草稿"),
    ]);
    expect(await mixed.json()).toMatchObject({ results: [{ status: "permission_denied" }, { status: "accepted" }] });
    const adminPersonalAttempt = await push(fixture, [
      operation(crypto.randomUUID(), memberPersonal.id, 0, "管理员也不能看"),
    ]);
    expect(await adminPersonalAttempt.json()).toMatchObject({ results: [{ status: "permission_denied" }] });

    const otherChoir = await provisionChoir({
      binding: env.DB,
      adminUserId: member.userId,
      adminDisplayName: "另一云盘管理员",
      inviteSecret: env.INVITE_SECRET,
    });
    const crossChoir = await callWorker(
      `/api/choirs/${otherChoir.choirId}/scores/${fixture.scoreId}/annotations/push`,
      jsonRequest(member.cookie, { operations: [operation(crypto.randomUUID(), fixture.layerId, 0, "伪造")]}),
    );
    expect(crossChoir.status).toBe(404);

    const guestCookie = await createGuestCookie(fixture.joinCode!);
    const guestLayers = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/layers`,
      { headers: { cookie: guestCookie } },
    );
    expect(await guestLayers.json()).toMatchObject({
      layers: expect.arrayContaining([
        expect.objectContaining({
          id: fixture.layerId,
          kind: "shared",
          canEdit: false,
        }),
      ]),
    });
    const guestPush = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations/push`,
      jsonRequest(guestCookie, {
        operations: [operation(crypto.randomUUID(), fixture.layerId, 0, "访客不可写")],
      }),
    );
    expect(guestPush.status).toBe(401);

    const guestPull = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations?cursor=0`,
      { headers: { cookie: guestCookie } },
    );
    expect(await guestPull.json()).toMatchObject({
      objects: [
        {
          createdByDisplayName: "",
          updatedByDisplayName: "",
        },
      ],
    });
  });
});

async function createFixture() {
  const admin = await signIn("annotation-admin@example.test");
  const provisioned = await provisionChoir({
    binding: env.DB,
    adminUserId: admin.userId,
    adminDisplayName: "管理员",
    inviteSecret: env.INVITE_SECRET,
  });
  const upload = await callWorker(
    `/api/choirs/${provisioned.choirId}/scores`,
    uploadRequest(admin.cookie, "排练曲.pdf"),
  );
  const scoreId = ((await upload.json()) as { score: { id: string } }).score.id;
  const layerResponse = await callWorker(
    `/api/choirs/${provisioned.choirId}/scores/${scoreId}/layers`,
    { headers: { cookie: admin.cookie } },
  );
  const layerId = ((await layerResponse.json()) as {
    layers: Array<{ id: string; sharedSlot: string | null }>;
  }).layers.find((layer) => layer.sharedSlot === "E")!.id;
  return {
    adminCookie: admin.cookie,
    adminUserId: admin.userId,
    choirId: provisioned.choirId,
    joinCode: provisioned.joinCode,
    scoreId,
    layerId,
  };
}

async function createMember(joinCode: string, email: string, name: string) {
  const account = await signIn(email);
  const joined = await callWorker(
    "/api/choirs/join",
    jsonRequest(account.cookie, {
      admission: "invite",
      joinCode,
      displayName: name,
    }),
  );
  expect(joined.status).toBe(201);
  return account;
}

async function layerBySlot(
  fixture: { choirId: string; scoreId: string },
  cookie: string,
  slot: string,
) {
  const response = await callWorker(
    `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/layers`,
    { headers: { cookie } },
  );
  const body = (await response.json()) as {
    layers: Array<Record<string, unknown> & { sharedSlot: string | null }>;
  };
  return body.layers.find((layer) => layer.sharedSlot === slot);
}

async function signIn(email: string) {
  const registration = await registerWithPassword({
    callWorker,
    email,
    latestOtp: () => deliveredOtp,
  });
  const found = await createDatabase(env.DB).query.user.findFirst({
    where: eq(user.email, email),
  });
  return { cookie: registration.cookie, userId: found!.id };
}

async function createGuestCookie(joinCode: string) {
  const response = await callWorker(
    "/api/guest/session",
    jsonRequest(
      "",
      { admission: "invite", joinCode },
      { "CF-Connecting-IP": "192.0.2.22" },
    ),
  );
  return cookieFrom(response);
}

function operation(annotationId: string, layerId: string, baseVersion: number, text: string) {
  return {
    opId: crypto.randomUUID(),
    annotationId,
    layerId,
    baseVersion,
    type: "upsert" as const,
    payload: {
      kind: "text" as const,
      pageNumber: 1,
      x: 0.2,
      y: 0.3,
      fontScale: 0.024,
      text,
    },
  };
}

function push(
  fixture: {
    choirId: string;
    scoreId: string;
    adminCookie: string;
    adminUserId: string;
  },
  operations: unknown[],
) {
  return callWorker(
    `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations/push`,
    jsonRequest(
      fixture.adminCookie,
      { operations },
      { "x-same-page-owner-user-id": fixture.adminUserId },
    ),
  );
}

function jsonRequest(cookie: string, body: unknown, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function uploadRequest(cookie: string, fileName: string): RequestInit {
  const form = new FormData();
  form.set("file", new File([createMinimalPdf()], fileName, { type: "application/pdf" }));
  return { method: "POST", headers: { cookie }, body: form };
}

function createMinimalPdf(): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(encoder.encode(body).byteLength);
    body += object;
  }
  const xrefOffset = encoder.encode(body).byteLength;
  body += `xref\n0 4\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(body);
}

async function callWorker(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://same-page.test${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
