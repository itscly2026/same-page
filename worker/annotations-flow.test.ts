import { noCapabilities } from "../src/shared/drive-permissions";
import { cleanupAnnotationLayers } from "./annotations/cleanup";
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
  type TestContext,
} from "vitest";

import worker from "./index";
import { provisionChoir } from "./choirs/provision";
import { createScoreVersion } from "./scores/storage";
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
      "DELETE FROM annotation_layers",
      "DELETE FROM score_object_deletions",
      "DELETE FROM score_versions",
      "DELETE FROM scores",
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
  it("experience reads omit account layers and do not create a member personal layer", async (context) => {
    const stage = trackAnnotationStages(context, "experience");
    const fixture = await createFixture(() => stage("first-score"));
    stage("member-identity");
    const member = await createMember(fixture.joinCode!, "experience@example.test", "体验者");
    stage("experience-layers");
    const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
    const count = () => env.DB.prepare("SELECT COUNT(*) AS count FROM annotation_layers WHERE score_id = ? AND owner_user_id = ?").bind(fixture.scoreId, member.userId).first();
    expect(await count()).toEqual({ count: 0 });
    const response = await callWorker(`${base}/layers?experience=1`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as { layers: { kind: string; canEdit: boolean }[] };
    expect(body.layers).toHaveLength(5);
    expect(body.layers.every(layer => layer.kind === "shared" && !layer.canEdit)).toBe(true);
    expect(await count()).toEqual({ count: 0 });
    stage("experience-annotations");
    const personal = await env.DB.prepare("SELECT id FROM annotation_layers WHERE score_id = ? AND owner_user_id = ?").bind(fixture.scoreId, fixture.ownerUserId).first<{ id: string }>();
    await push(fixture, [operation(crypto.randomUUID(), personal!.id, 0, "账号私有笔记"), operation(crypto.randomUUID(), fixture.layerId, 0, "公开共享内容")]);
    const pulled = await callWorker(`${base}/annotations?experience=1`, { headers: { cookie: fixture.adminCookie } });
    const notes = await pulled.json() as { objects: { layerId: string }[] };
    expect(notes.objects.map(note => note.layerId)).toEqual([fixture.layerId]);
    stage(null);
  });

  it("rejects preference and display name requests captured for a different user", async () => {
    const fixture = await createFixture();
    const paths = [
      `/api/choirs/${fixture.choirId}/shared-layers/E/preference`,
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/shared-layers/E/preference`,
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/personal-layers/${fixture.layerId}/subscription`,
      `/api/choirs/${fixture.choirId}/display-name`,
      `/api/choirs/${fixture.choirId}/settings`,
      `/api/choirs/${fixture.choirId}/shared-layer-preferences`,
    ];
    for (const path of paths) {
      const read = path.endsWith("/settings") || path.endsWith("/shared-layer-preferences");
      const response = await callWorker(path, { method: read ? "GET" : path.endsWith("display-name") ? "PATCH" : "PUT",
        headers: { cookie: fixture.adminCookie, "content-type": "application/json", "x-same-page-owner-user-id": "other-user" },
        body: read ? undefined : JSON.stringify(path.endsWith("display-name") ? { displayName: "wrong user", expectedRevision: 0 } : { subscribed: false }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "identity_changed" });
    }
  });

  it.for(["E", "custom"] as const)("recycles %s across scores, retaining identity, grants and preferences while rejecting stale actions", { timeout: 15_000 }, async (slotKind, context) => {
    const stage = trackAnnotationStages(context, slotKind);
    const fixture = await createFixture(() => stage("first-score"));
    stage("member-identity");
    const member = await createMember(fixture.joinCode!, "recycle@example.test", "成员");
    stage("permissions-and-scores");
    const base = `/api/choirs/${fixture.choirId}`;
    const slot = slotKind === "E" ? "E" : (await (await callWorker(`${base}/shared-layers`, jsonRequest(fixture.adminCookie, { name: "伴奏", defaultColor: "#123456" }))).json() as { slot: string }).slot;
    const list = async (state = "current") => (await (await callWorker(`${base}/shared-layers?state=${state}`, { headers: { cookie: fixture.adminCookie } })).json() as { layers: SharedLayerManagementSummary[] }).layers;
    const change = (action: string, expectedRevision: number, cookie = fixture.adminCookie) => callWorker(`${base}/shared-layers/${slot}/lifecycle`, jsonRequest(cookie, { action, expectedRevision }));
    const put = (path: string, body: unknown) => callWorker(`${base}${path}`, { ...jsonRequest(fixture.adminCookie, body), method: "PUT" });
    const members = await (await callWorker(`${base}/memberships`, { headers: { cookie: fixture.adminCookie } })).json() as { memberships: { id: string; displayName: string }[] };
    const memberId = members.memberships.find(row => row.displayName === "成员")!.id;
    await setLayerPermission(fixture, memberId, slot, true);
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
    stage("delete");
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
    expect((await put(`/shared-layers/${slot}/order`, { direction: "up" })).status).toBe(404);
    const pullPath = `${base}/scores/${fixture.scoreId}/annotations`;
    expect(await (await callWorker(pullPath, { headers: { cookie: fixture.adminCookie } })).json()).toMatchObject({ objects: [] });
    stage("restore");
    expect((await change("restore", deleted.revision, member.cookie)).status).toBe(403);
    expect((await change("restore", original.revision)).status).toBe(409);
    expect((await change("restore", deleted.revision)).status).toBe(200);
    await cleanupAnnotationLayers(env.DB, deleted.recoverUntil! + 1);
    expect(await layerBySlot(fixture, fixture.adminCookie, slot)).toMatchObject({ id: layer!.id, subscribed: true, driveSubscribed: false, driveColorOverride: "#987654" });
    expect(await layerBySlot(fixture, member.cookie, slot)).toMatchObject({ id: layer!.id, canEdit: true });
    expect(await layerBySlot(second, fixture.adminCookie, slot)).toMatchObject({ id: secondLayer!.id });
    expect(await (await callWorker(pullPath, { headers: { cookie: fixture.adminCookie } })).json()).toMatchObject({ objects: [{ id: objectId, version: 1, payload: { text: "第一首提示" } }] });
    stage("paused-restore");
    const paused = await put(`/shared-layers/${slot}/settings`, { active: false });
    expect(paused.status).toBe(200);
    const beforePauseDelete = (await list()).find(row => row.slot === slot)!;
    await change("delete", beforePauseDelete.revision);
    const pausedDeleted = (await list("deleted")).find(row => row.slot === slot)!;
    await change("restore", pausedDeleted.revision);
    expect((await list()).find(row => row.slot === slot)).toMatchObject({ active: false, sortOrder: original.sortOrder });
    expect(await layerBySlot(fixture, fixture.adminCookie, slot)).toBeUndefined();
    expect(await layerBySlot(fixture, fixture.adminCookie, "S")).toBeDefined();
    stage(null);
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
    await cleanupAnnotationLayers(env.DB);
    await cleanupAnnotationLayers(env.DB);
    const list = await (await callWorker(`${base}/shared-layers?state=deleted`, { headers: { cookie: fixture.adminCookie } })).json();
    expect(list).toMatchObject({ layers: [] });
    for (const table of ["annotation_layers", "annotation_objects", "annotation_sync_operations", "user_drive_layer_preferences", "user_score_layer_preferences"]) {
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

  it("keeps named personal layers independent through sharing, rename, deletion, conflicts and restore", async () => {
    const fixture = await createFixture();
    const author = await createMember(fixture.joinCode!, "multi@example.test", "作者");
    const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
    const list = async (cookie = author.cookie) => (await (await callWorker(`${base}/layers`, { headers: { cookie } })).json() as { layers: Array<{ id: string; name: string; kind: string; canEdit: boolean; revision: number; sharing: boolean; subscribed: boolean }> }).layers;
    const create = async (name: string) => {
      const response = await callWorker(`${base}/personal-layers`, jsonRequest(author.cookie, { id: crypto.randomUUID(), name }));
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const update = (id: string, body: unknown, cookie = author.cookie) => callWorker(`${base}/personal-layers/${id}`, { ...jsonRequest(cookie, body), method: "PUT" });
    await list();
    const rehearsal = await create("排练记录"), concert = await create("演出提示");
    expect((await list()).filter(layer => layer.canEdit && layer.kind === "personal").map(layer => layer.name)).toEqual(["我的笔记", "排练记录", "演出提示"]);
    const actor = { ...fixture, adminCookie: author.cookie, ownerUserId: author.userId };
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    expect(await (await push(actor, [operation(first, rehearsal, 0, "呼吸"), operation(second, concert, 0, "看指挥")])).json()).toMatchObject({ results: [{ status: "accepted" }, { status: "accepted" }] });
    expect((await update(rehearsal, { sharing: true, expectedRevision: 0 })).status).toBe(200);
    expect((await list(fixture.adminCookie)).filter(layer => [rehearsal, concert].includes(layer.id))).toMatchObject([{ id: rehearsal, name: "作者 · 排练记录", canEdit: false }]);
    expect((await update(concert, { sharing: true, expectedRevision: 0 }, fixture.adminCookie)).status).toBe(409);
    expect((await update(rehearsal, { name: "排练记录二", expectedRevision: 1 })).status).toBe(200);
    expect((await update(rehearsal, { action: "delete", expectedRevision: 1 })).status).toBe(409);
    expect((await update(rehearsal, { action: "delete", expectedRevision: 2 })).status).toBe(200);
    expect((await list()).some(layer => layer.id === rehearsal)).toBe(false);
    expect((await list(fixture.adminCookie)).some(layer => layer.id === rehearsal)).toBe(false);
    expect(await (await push(actor, [operation(first, rehearsal, 1, "离线晚到"), operation(second, concert, 1, "另一层继续")])).json()).toMatchObject({ results: [{ status: "permission_denied" }, { status: "accepted" }] });
    expect((await update(rehearsal, { action: "restore", expectedRevision: 3 })).status).toBe(200);
    expect((await list()).find(layer => layer.id === rehearsal)).toMatchObject({ name: "排练记录二", sharing: false });
    expect(await (await push(actor, [operation(first, rehearsal, 0, "离线冲突")])).json()).toMatchObject({ results: [{ status: "conflict" }] });
    const subscribe = await callWorker(`${base}/personal-layers/${concert}/subscription`, { ...jsonRequest(author.cookie, { subscribed: false }), method: "PUT" });
    expect(subscribe.status).toBe(200);
    expect((await list()).find(layer => layer.id === concert)).toMatchObject({ subscribed: false });
    expect((await update(rehearsal, { action: "delete", expectedRevision: 4 })).status).toBe(200);
    await cleanupAnnotationLayers(env.DB, Date.now() + RECOVERY_PERIOD_MS + 1);
    expect((await update(rehearsal, { action: "restore", expectedRevision: 5 })).status).toBe(409);
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
    const authorFixture = { ...fixture, adminCookie: author.cookie, ownerUserId: author.userId };
    const objectId = crypto.randomUUID();
    await push(authorFixture, [operation(objectId, personal.id, 0, "我的排练笔记")]);
    expect((await list(reader.cookie)).some(layer => layer.id === personal.id)).toBe(false);
    const share = async (sharing: boolean) => {
      const current = (await (await callWorker(`${base}/layers`, { headers: { cookie: author.cookie } })).json() as { layers: { id: string; revision: number }[] }).layers.find(layer => layer.id === personal.id)!;
      return callWorker(`${base}/personal-layers/${personal.id}`, { ...jsonRequest(author.cookie, { sharing, expectedRevision: current.revision }), method: "PUT" });
    };
    expect((await share(true)).status).toBe(200);
    for (const cookie of [reader.cookie, fixture.adminCookie]) {
      expect((await list(cookie)).find(layer => layer.id === personal.id)).toMatchObject({ sharing: true, subscribed: false, canEdit: false });
    }
    const subscribe = await callWorker(`${base}/personal-layers/${personal.id}/subscription`, { ...jsonRequest(reader.cookie, { subscribed: true }), method: "PUT" });
    expect(subscribe.status).toBe(200);
    expect((await list(reader.cookie)).find(layer => layer.id === personal.id)).toMatchObject({ subscribed: true });
    for (const actor of [fixture, { ...fixture, adminCookie: reader.cookie, ownerUserId: reader.userId }]) {
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
    const membersResponse = await callWorker(`/api/choirs/${fixture.choirId}/memberships`, { headers: { cookie: fixture.adminCookie } });
    const { memberships: members } = await membersResponse.json() as { memberships: Array<{ id: string; displayName: string }> };
    const authorMembership = members.find(member => member.displayName === "声部长")!;
    await callWorker(`/api/choirs/${fixture.choirId}/memberships/${authorMembership.id}`, jsonRequest(fixture.adminCookie, { action: "remove", expectedRevision: 0 }));
    expect(await pull(reader.cookie)).toMatchObject({ objects: [] });
  });

  it("rejects a sharing request suspended across member removal and restoration", async () => {
    const fixture = await createFixture();
    const author = await createMember(fixture.joinCode!, "delayed-share@example.test", "作者");
    const member = await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, author.userId) });
    const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}`;
    const layers = await (await callWorker(`${base}/layers`, { headers: { cookie: author.cookie } })).json() as { layers: { id: string; kind: string }[] };
    const personal = layers.layers.find(layer => layer.kind === "personal")!;
    const DB = new Proxy(env.DB, { get(db, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith("UPDATE annotation_layers SET\n    name")) return statement;
        return new Proxy(statement, { get(statement, key) {
          if (key === "bind") return (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return new Proxy(bound, { get(bound, key) {
              if (key === "run") return async () => {
                const path = `/api/choirs/${fixture.choirId}/memberships/${member!.id}`;
                expect((await callWorker(path, jsonRequest(fixture.adminCookie, { action: "remove", expectedRevision: 0 }))).status).toBe(204);
                expect((await callWorker(path, jsonRequest(fixture.adminCookie, { action: "restore", expectedRevision: 1 }))).status).toBe(204);
                return bound.run();
              };
              const value = Reflect.get(bound, key); return typeof value === "function" ? value.bind(bound) : value;
            } });
          };
          const value = Reflect.get(statement, key); return typeof value === "function" ? value.bind(statement) : value;
        } });
      };
      const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
    } });
    const execution = createExecutionContext();
    const response = await worker.fetch(new Request(`https://same-page.test${base}/personal-layers/${personal.id}`, { ...jsonRequest(author.cookie, { sharing: true, expectedRevision: 0 }), method: "PUT" }), { ...env, DB }, execution);
    await waitOnExecutionContext(execution);
    expect(response.status).toBe(409);
    const readerLayers = await (await callWorker(`${base}/layers`, { headers: { cookie: fixture.adminCookie } })).json() as { layers: { id: string }[] };
    expect(readerLayers.layers.some(layer => layer.id === personal.id)).toBe(false);
  });

  it.each(["target", "actor"])("rejects a delayed grant across %s membership changes", async (changed) => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "grant-target@example.test", "成员");
    const target = await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, member.userId) });
    const actor = await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, fixture.ownerUserId) });
    const another = changed === "actor" ? await createMember(fixture.joinCode!, "grant-another@example.test", "另一成员") : null;
    const grantTarget = another ? await createDatabase(env.DB).query.memberships.findFirst({ where: eq(memberships.userId, another.userId) }) : target;
    const DB = new Proxy(env.DB, { get(db, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        if (changed === "actor") expect((await callWorker(`/api/choirs/${fixture.choirId}/ownership`, jsonRequest(fixture.adminCookie, { membershipId: target!.id, confirm: true }))).status).toBe(204);
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
    const response = await worker.fetch(new Request(`https://same-page.test/api/choirs/${fixture.choirId}/memberships/${grantTarget!.id}/permissions`, { ...jsonRequest(fixture.adminCookie, { expectedRevision: 0, operations: { operations: [], sharedLayers: ["E"] }, management: { operations: [], sharedLayers: [] } }), method: "PUT" }), { ...env, DB }, execution);
    await waitOnExecutionContext(execution);
    expect(response.status).toBe(409);
    const grants = await callWorker(`/api/choirs/${fixture.choirId}/memberships`, { headers: { cookie: changed === "target" ? fixture.adminCookie : member.cookie } });
    expect(await grants.json()).toMatchObject({ memberships: expect.arrayContaining([expect.objectContaining({ id: grantTarget!.id, isOwner: 0, operations: { operations: [], sharedLayers: [] } })]) });
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
      const response = await worker.fetch(new Request(`https://same-page.test/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations/push`, jsonRequest(fixture.adminCookie, { operations }, { "x-same-page-owner-user-id": fixture.ownerUserId })), { ...env, DB }, execution);
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
      scores: [{ id: fixture.scoreId }], permissions: { capabilities: noCapabilities(), access: "preview" },
    });
    const layers = await read(`${base}/layers`, first.cookie);
    expect(layers.status).toBe(200);
    const body = await layers.json() as { layers: Array<{ id: string; kind: string; canEdit: boolean }> };
    const personal = body.layers.find((layer) => layer.kind === "personal")!;
    expect(personal.canEdit).toBe(true);
    expect(body.layers.filter((layer) => layer.kind === "shared").every((layer) => !layer.canEdit)).toBe(true);
    const author = { ...fixture, adminCookie: first.cookie, ownerUserId: first.userId };
    const op = operation(crypto.randomUUID(), personal.id, 0, "只属于我");
    expect(await (await push(author, [op])).json()).toMatchObject({ results: [{ status: "accepted" }] });
    // Reloading the layers and pulling from a fresh request retains the same private content.
    expect(await (await read(`${base}/layers`, first.cookie)).json()).toMatchObject({
      layers: expect.arrayContaining([expect.objectContaining({ id: personal.id })]),
    });
    expect(await (await read(`${base}/annotations`, first.cookie)).json()).toMatchObject({
      objects: [expect.objectContaining({ id: op.annotationId, payload: expect.objectContaining({ text: "只属于我" }) })],
    });
    for (const other of [second, { cookie: fixture.adminCookie, userId: fixture.ownerUserId }]) {
      expect(await (await read(`${base}/layers`, other.cookie)).json()).not.toMatchObject({
        layers: expect.arrayContaining([expect.objectContaining({ id: personal.id })]),
      });
      expect(await (await read(`${base}/annotations`, other.cookie)).json()).toMatchObject({ objects: [] });
      expect(await (await push({ ...fixture, adminCookie: other.cookie, ownerUserId: other.userId }, [
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

  it("preserves alignment for legacy writers but accepts explicit centered undo idempotently", async () => {
    const fixture = await createFixture();
    const first = operation(crypto.randomUUID(), fixture.layerId, 0, "旧居中");
    await push(fixture, [first]);
    const aligned = { ...operation(first.annotationId, fixture.layerId, 1, "左对齐"), payload: { ...first.payload, textAlign: "left" } };
    expect(await (await push(fixture, [aligned])).json()).toMatchObject({ results: [{ status: "accepted", object: { version: 2, payload: { textAlign: "left" } } }] });
    const legacy = operation(first.annotationId, fixture.layerId, 2, "旧客户端改字");
    expect(await (await push(fixture, [legacy])).json()).toMatchObject({ results: [{ status: "accepted", object: { version: 3, payload: { text: "旧客户端改字", textAlign: "left" } } }] });
    expect(await (await push(fixture, [legacy])).json()).toMatchObject({ results: [{ status: "accepted", object: { version: 3 } }] });
    const undo = { ...operation(first.annotationId, fixture.layerId, 3, "旧居中"), payload: { ...first.payload, textAlign: "center" } };
    expect(await (await push(fixture, [undo])).json()).toMatchObject({ results: [{ status: "accepted", object: { version: 4, payload: { textAlign: "center" } } }] });
    expect(await (await push(fixture, [undo])).json()).toMatchObject({ results: [{ status: "accepted", object: { version: 4 } }] });
    expect(await (await push(fixture, [{ ...undo, payload: { ...undo.payload, textAlign: "right" } }])).json()).toMatchObject({ results: [{ status: "op_id_reused" }] });
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

  it("resolves score subscriptions over user drive defaults with independent score colors", async () => {
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
    })).status).toBe(200);
    expect((await callWorker(scorePath, {
      ...jsonRequest(member.cookie, { subscribed: true }),
      method: "PUT",
    })).status).toBe(200);

    const customized = await layerBySlot(fixture, member.cookie, "E");
    expect(customized).toMatchObject({
      subscribed: true,
      subscriptionSource: "score",
      displayColor: "#445566",
      colorSource: "score",
      driveSubscribed: false,
      scoreSubscriptionOverride: true,
    });

    const secondUpload = await callWorker(`/api/choirs/${fixture.choirId}/scores`, uploadRequest(fixture.adminCookie, "颜色隔离.pdf"));
    const secondScore = (await secondUpload.json() as { score: { id: string } }).score.id;
    expect(await layerBySlot({ ...fixture, scoreId: secondScore }, member.cookie, "E")).toMatchObject({ displayColor: "#112233", subscribed: false, colorSource: "drive" });
    expect(await layerBySlot(fixture, fixture.adminCookie, "E")).toMatchObject({ displayColor: "#dc2626", subscribed: true });
    await callWorker(drivePath, { ...jsonRequest(member.cookie, { colorOverride: "#778899", subscribed: false }), method: "PUT" });
    expect(await layerBySlot(fixture, member.cookie, "E")).toMatchObject({ displayColor: "#445566", subscribed: true, colorSource: "score" });

    expect((await callWorker(scorePath, {
      ...jsonRequest(member.cookie, { subscribed: null, colorOverride: null }),
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
          adminDefaultColor: "#dc2626",
          displayColor: "#dc2626",
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
          defaultColor: "#dc2626",
          grantedMemberCount: 0,
          sortOrder: 0, active: true, revision: 0, deletedAt: null, recoverUntil: null,
        },
      ]),
    });

    const memberRow = await createDatabase(env.DB).query.memberships.findFirst({
      where: eq(memberships.userId, member.userId),
    });
    expect((await setLayerPermission(fixture, memberRow!.id, "E", true)).status).toBe(204);
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
    const grant = await setLayerPermission(fixture, memberRow!.id, "E", true);
    expect(grant.status).toBe(204);

    const accepted = await push(
      { ...fixture, adminCookie: member.cookie, ownerUserId: member.userId },
      [operation(crypto.randomUUID(), fixture.layerId, 0, "获授权")],
    );
    expect(accepted.status).toBe(200);
    const revoke = await setLayerPermission(fixture, memberRow!.id, "E", false);
    expect(revoke.status).toBe(204);
    const revoked = await push(
      { ...fixture, adminCookie: member.cookie, ownerUserId: member.userId },
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
    const mixed = await push({ ...fixture, adminCookie: member.cookie, ownerUserId: member.userId }, [
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
      ownerUserId: member.userId,
      ownerDisplayName: "另一云盘管理员",
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

// Fixed labels and durations only: never serialize a fixture, request or error.
// The test signal captures the active stage at timeout, before teardown runs.
type AnnotationStage = "owner-identity" | "first-score" | "member-identity" | "permissions-and-scores" | "delete" | "restore" | "paused-restore" | "experience-layers" | "experience-annotations";
function trackAnnotationStages(context: TestContext, variant: "E" | "custom" | "experience") {
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  let current: AnnotationStage | null = "owner-identity";
  const completed: { stage: AnnotationStage; durationMs: number }[] = [];
  const snapshot = () => {
    const now = performance.now();
    return { event: variant === "experience" ? "worker_experience_stage_timing" : "worker_recycle_stage_timing", variant,
      totalMs: Math.round(now - startedAt), completed: [...completed],
      running: current ? { stage: current, durationMs: Math.round(now - stageStartedAt) } : null };
  };
  let timedOut: ReturnType<typeof snapshot> | undefined;
  const capture = () => { timedOut = snapshot(); };
  context.signal.addEventListener("abort", capture, { once: true });
  context.onTestFinished(() => context.signal.removeEventListener("abort", capture));
  context.onTestFailed(() => console.error(JSON.stringify(timedOut ?? snapshot())));
  return (next: AnnotationStage | null) => {
    if (context.signal.aborted) return;
    const now = performance.now();
    if (current) completed.push({ stage: current, durationMs: Math.round(now - stageStartedAt) });
    current = next;
    stageStartedAt = now;
  };
}

async function createFixture(onOwnerReady?: () => void) {
  const admin = await signIn("annotation-admin@example.test");
  onOwnerReady?.();
  const provisioned = await provisionChoir({
    binding: env.DB,
    ownerUserId: admin.userId,
    ownerDisplayName: "管理员",
    inviteSecret: env.INVITE_SECRET,
  });
  // This suite tests annotation authorization, not PDF parsing. Use the real
  // storage module with our known one-page PDF; scores-flow covers uploads and
  // inspectPdf. Avoid charging the parser's cold start to the first layer test.
  const owner = await env.DB.prepare("SELECT id FROM memberships WHERE choir_id = ? AND user_id = ?")
    .bind(provisioned.choirId, admin.userId).first<{ id: string }>();
  const data = new Uint8Array(createMinimalPdf()).buffer;
  const { scoreId } = await createScoreVersion({
    env, choirId: provisioned.choirId, membershipId: owner!.id,
    fileName: "排练曲.pdf", fileNameKey: "排练曲.pdf",
    pdf: { data, sizeBytes: data.byteLength, pageCount: 1, sha256: await sha256(data) },
  });
  const layerResponse = await callWorker(
    `/api/choirs/${provisioned.choirId}/scores/${scoreId}/layers`,
    { headers: { cookie: admin.cookie } },
  );
  const layerId = ((await layerResponse.json()) as {
    layers: Array<{ id: string; sharedSlot: string | null }>;
  }).layers.find((layer) => layer.sharedSlot === "E")!.id;
  return {
    adminCookie: admin.cookie,
    ownerUserId: admin.userId,
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
    ownerUserId: string;
  },
  operations: unknown[],
) {
  return callWorker(
    `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/annotations/push`,
    jsonRequest(
      fixture.adminCookie,
      { operations },
      { "x-same-page-owner-user-id": fixture.ownerUserId },
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

async function sha256(value: string | ArrayBuffer) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function setLayerPermission(fixture: { choirId: string; adminCookie: string }, membershipId: string, slot: string, granted: boolean) {
  const listing = await callWorker(`/api/choirs/${fixture.choirId}/memberships`, { headers: { cookie: fixture.adminCookie } });
  const data = await listing.json() as { memberships: Array<{ id: string; revision: number; operations: { operations: string[]; sharedLayers: string[] }; management: object }> };
  const target = data.memberships.find(member => member.id === membershipId)!;
  return callWorker(`/api/choirs/${fixture.choirId}/memberships/${membershipId}/permissions`, { ...jsonRequest(fixture.adminCookie, {
    expectedRevision: target.revision, operations: { ...target.operations, sharedLayers: granted ? [...target.operations.sharedLayers, slot] : target.operations.sharedLayers.filter(value => value !== slot) }, management: target.management,
  }), method: "PUT" });
}

it("keeps finite shared-slot grants stable and separates configuration from content editing", async () => {
  const fixture = await createFixture();
  const member = await createMember(fixture.joinCode!, "layer-config@example.test", "层配置员");
  const base = `/api/choirs/${fixture.choirId}`;
  const listing = await (await callWorker(`${base}/memberships`, { headers: { cookie: fixture.adminCookie } })).json() as { memberships: Array<{ id: string; displayName: string; revision: number }> };
  const target = listing.memberships.find(row => row.displayName === "层配置员")!;
  expect((await callWorker(`${base}/memberships/${target.id}/permissions`, { ...jsonRequest(fixture.adminCookie, { expectedRevision: target.revision, operations: { operations: ["configureLayers"], sharedLayers: ["S"] }, management: { operations: [], sharedLayers: [] } }), method: "PUT" })).status).toBe(204);
  expect(await layerBySlot(fixture, member.cookie, "S")).toMatchObject({ canEdit: true });
  expect(await layerBySlot(fixture, member.cookie, "E")).toMatchObject({ canEdit: false });
  expect((await callWorker(`${base}/shared-layers/S/settings`, { ...jsonRequest(member.cookie, { name: "高声部" }), method: "PUT" })).status).toBe(200);
  expect(await layerBySlot(fixture, member.cookie, "S")).toMatchObject({ canEdit: true, name: "高声部" });
  const created = await callWorker(`${base}/shared-layers`, jsonRequest(member.cookie, { name: "新增层", defaultColor: "#123456" }));
  expect(created.status).toBe(201);
  const { slot } = await created.json() as { slot: string };
  expect(await layerBySlot(fixture, member.cookie, slot)).toMatchObject({ canEdit: false });
});

it("reader sync combines current score, layers and cursor data with one authorization pass", async () => {
  const fixture = await createFixture();
  const sql: string[] = [];
  const binding = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (query: string) => { sql.push(query); return target.prepare(query); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://same-page.test/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/sync`, {
    headers: { cookie: fixture.adminCookie },
  }), { ...env, DB: binding }, context);
  await waitOnExecutionContext(context);
  expect(response.status).toBe(200);
  const body = await response.json() as { state: string; score: { id: string }; layers: { layers: unknown[] }; annotations: { objects: unknown[]; hasMore: boolean } };
  expect(body).toMatchObject({ state: "active", score: { id: fixture.scoreId }, annotations: { objects: [], hasMore: false } });
  expect(body.layers.layers).toHaveLength(6);
  expect(sql.filter(query => query.includes('from "session"'))).toHaveLength(1);
  expect(sql.filter(query => query.includes('from "user"'))).toHaveLength(1);
  expect(sql.some(query => query === "SELECT trashed_at FROM scores WHERE id = ? AND choir_id = ?")).toBe(false);
});

it("reader sync resets the cursor when the visible layer set changes", async () => {
  const fixture = await createFixture();
  const id = crypto.randomUUID();
  expect((await push(fixture, [operation(id, fixture.layerId, 0, "早先的笔记")])).status).toBe(200);
  const base = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/sync`;
  const request = () => callWorker(`${base}?cursor=999999&layerIds=%5B%5D`, { headers: { cookie: fixture.adminCookie } });
  expect(await (await request()).json()).toMatchObject({ annotations: { objects: [expect.objectContaining({ id })] } });
  const invalid = await callWorker(`${base}?cursor=-1`, { headers: { cookie: fixture.adminCookie } });
  expect(invalid.status).toBe(400);
  await env.DB.prepare("UPDATE scores SET trashed_at = ?, trash_expires_at = ? WHERE id = ?").bind(Date.now(), Date.now() + 10000, fixture.scoreId).run();
  expect(await (await request()).json()).toMatchObject({ state: "trashed" });
});
