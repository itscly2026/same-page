import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import { provisionChoir } from "./choirs/provision";
import { cleanupLifecycles, RECOVERY_PERIOD_MS } from "./lifecycle/cleanup";
import { cookieFrom, registerWithPassword, signInWithPassword } from "./test/auth";

const network = setupNetwork();
let otp = "";
beforeAll(() => network.enable());
afterAll(() => network.disable());
afterEach(() => network.resetHandlers());
beforeEach(async () => {
  network.use(http.post("https://api.resend.com/emails", async ({ request }) => {
    otp = (await request.json() as { text: string }).text.match(/验证码：([0-9]{6})/)?.[1] ?? "";
    return HttpResponse.json({ id: "mail" });
  }));
  await env.DB.batch(["DELETE FROM choirs", "DELETE FROM user", "DELETE FROM verification", "DELETE FROM rate_limits"].map((sql) => env.DB.prepare(sql)));
});
const callWorker = async (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://same-page.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx); return response;
};
const post = (path: string, cookie: string, body: unknown = {}) => callWorker(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
async function person(email: string) {
  const registration = await registerWithPassword({ callWorker, email, latestOtp: () => otp });
  const row = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { id: row!.id, email, cookie: registration.cookie };
}
async function reauthenticate(user: Awaited<ReturnType<typeof person>>) {
  expect((await post("/api/user/lifecycle/reauthenticate", user.cookie, { expectedUserId: user.id })).status).toBe(204);
  const login = await signInWithPassword({ callWorker, email: user.email });
  expect(login.status).toBe(200);
  return cookieFrom(login);
}
const state = async (cookie: string) => (await callWorker("/api/user/lifecycle", { headers: { cookie } })).json() as Promise<{
  deletion: { deletionId: string; expiresAt: number; authMethod: string } | null;
  memberships: { id: string; revision: number; status: string; isOwner: number }[];
  reauthenticated: boolean;
}>;
async function drive(admin: Awaited<ReturnType<typeof person>>, member?: Awaited<ReturnType<typeof person>>) {
  const { choirId } = await provisionChoir({ binding: env.DB, ownerUserId: admin.id, ownerDisplayName: "管理员甲", inviteSecret: env.INVITE_SECRET });
  if (member) await env.DB.prepare("INSERT INTO memberships (id, choir_id, user_id, display_name) VALUES (?, ?, ?, '成员乙')").bind(crypto.randomUUID(), choirId, member.id).run();
  return choirId;
}

it("transfers unique drive ownership without granting the former owner implicit powers", async () => {
  const owner = await person("owner@example.test"); const member = await person("member@example.test");
  const choirId = await drive(owner, member);
  const target = (await state(member.cookie)).memberships[0];
  expect((await post(`/api/choirs/${choirId}/ownership`, owner.cookie, { membershipId: target.id, confirm: true })).status).toBe(204);
  expect((await post(`/api/choirs/${choirId}/ownership`, owner.cookie, { membershipId: target.id, confirm: true })).status).toBe(403);
  expect((await callWorker(`/api/choirs/${choirId}/join-code`, { headers: { cookie: owner.cookie } })).status).toBe(403);
  expect((await callWorker(`/api/choirs/${choirId}/join-code`, { headers: { cookie: member.cookie } })).status).toBe(200);
});

describe("user and membership lifecycle", () => {
  it("requires a new verification and blocks deletion until every last-admin position is handed off", async () => {
    const admin = await person("admin@example.test"); const member = await person("member@example.test");
    const choirId = await drive(admin, member); await drive(admin);
    expect((await post("/api/user/lifecycle/delete", admin.cookie, { confirm: true, expectedUserId: admin.id })).status).toBe(409);
    const fresh = await reauthenticate(admin);
    expect((await state(fresh)).reauthenticated).toBe(true);
    expect((await post("/api/user/lifecycle/delete", fresh, { confirm: true, expectedUserId: admin.id })).status).toBe(409);
    expect((await state(fresh)).deletion).toBeNull();
    const membership = (await state(member.cookie)).memberships[0];
    expect((await post(`/api/choirs/${choirId}/ownership`, fresh, { membershipId: membership.id, confirm: true })).status).toBe(204);
    // An administrator in another drive is still required.
    expect((await post("/api/user/lifecycle/delete", fresh, { confirm: true, expectedUserId: admin.id })).status).toBe(409);
    expect((await callWorker(`/api/choirs/${choirId}/scores`, { headers: { cookie: fresh } })).status).toBe(200);
  });

  it("revokes sessions, restricts recovery login, restores only matching deletion and retains local-owner identity", async () => {
    const admin = await person("admin@example.test"); const member = await person("member@example.test");
    const choirId = await drive(admin, member);
    const fresh = await reauthenticate(member);
    expect((await post("/api/user/lifecycle/delete", fresh, { confirm: true, expectedUserId: admin.id })).status).toBe(409);
    expect((await post("/api/user/lifecycle/delete", fresh, { confirm: true, expectedUserId: member.id })).status).toBe(204);
    expect((await callWorker(`/api/choirs/${choirId}/scores`, { headers: { cookie: member.cookie } })).status).toBe(403);
    const login = await signInWithPassword({ callWorker, email: member.email });
    const deleted = await state(cookieFrom(login));
    expect(deleted.deletion?.authMethod).toBe("credential");
    expect((await callWorker(`/api/choirs/${choirId}/scores`, { headers: { cookie: cookieFrom(login) } })).status).toBe(403);
    expect(await (await callWorker("/api/auth/get-session", { headers: { cookie: cookieFrom(login) } })).json()).toBeNull();
    expect((await post("/api/user/lifecycle/restore", admin.cookie, { confirm: true, deletionId: deleted.deletion!.deletionId })).status).toBe(409);
    const memberRow = (await state(cookieFrom(login))).memberships[0];
    expect((await post(`/api/choirs/${choirId}/memberships/${memberRow.id}`, admin.cookie, { action: "restore", expectedRevision: memberRow.revision })).status).toBe(409);
    expect((await post("/api/user/lifecycle/restore", cookieFrom(login), { confirm: true, deletionId: deleted.deletion!.deletionId })).status).toBe(204);
    const restoredLogin = await signInWithPassword({ callWorker, email: member.email });
    expect((await state(cookieFrom(restoredLogin))).memberships[0]).toMatchObject({ id: memberRow.id, status: "active", isOwner: 0 });
    await env.DB.prepare("DELETE FROM rate_limits").run();
    const again = await reauthenticate({ ...member, cookie: cookieFrom(restoredLogin) });
    expect((await post("/api/user/lifecycle/delete", again, { confirm: true, expectedUserId: member.id })).status).toBe(204);
    const secondLogin = await signInWithPassword({ callWorker, email: member.email });
    expect((await post("/api/user/lifecycle/restore", cookieFrom(secondLogin), { confirm: true, deletionId: deleted.deletion!.deletionId })).status).toBe(409);
  });

  it("allows exit and administrator recovery with revision guards and no personal-layer authority", async () => {
    const admin = await person("admin@example.test"); const member = await person("member@example.test");
    const outsider = await person("outsider@example.test");
    const choirId = await drive(admin, member);
    const membership = (await state(member.cookie)).memberships[0];
    const path = `/api/choirs/${choirId}/memberships/${membership.id}`;
    expect((await post(path, outsider.cookie, { action: "remove", expectedRevision: 0 })).status).toBe(403);
    expect((await post(path, member.cookie, { action: "remove", expectedRevision: 0 })).status).toBe(204);
    expect((await post(path, member.cookie, { action: "remove", expectedRevision: 0 })).status).toBe(204);
    expect((await callWorker(`/api/choirs/${choirId}/scores`, { headers: { cookie: member.cookie } })).status).toBe(403);
    expect((await post(path, member.cookie, { action: "restore", expectedRevision: 1 })).status).toBe(403);
    expect((await post(path, admin.cookie, { action: "restore", expectedRevision: 1 })).status).toBe(204);
    expect((await post(path, admin.cookie, { action: "remove", expectedRevision: 0 })).status).toBe(409);
    expect((await post(path, member.cookie, { action: "remove", expectedRevision: 2 })).status).toBe(204);
    await cleanupLifecycles(env, Date.now() + RECOVERY_PERIOD_MS + 1);
    await cleanupLifecycles(env, Date.now() + RECOVERY_PERIOD_MS + 1);
    expect((await post(path, admin.cookie, { action: "restore", expectedRevision: 3 })).status).toBe(404);
  });

  it("serializes simultaneous member exits so the owner cannot leave", async () => {
    const a = await person("a@example.test"); const b = await person("b@example.test");
    const choirId = await drive(a, b);
    const bMember = (await state(b.cookie)).memberships[0];
    const aMember = (await state(a.cookie)).memberships[0];
    const results = await Promise.all([
      post(`/api/choirs/${choirId}/memberships/${aMember.id}`, a.cookie, { action: "remove", expectedRevision: 0 }),
      post(`/api/choirs/${choirId}/memberships/${bMember.id}`, b.cookie, { action: "remove", expectedRevision: 0 }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([204, 409]);
  });

  it("rejects a push revoked between authorization and commit, then accepts the same draft after restoration", async () => {
    const admin = await person("admin@example.test"); const member = await person("member@example.test");
    const choirId = await drive(admin, member);
    const membership = (await state(member.cookie)).memberships[0];
    const scoreId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO scores (id, choir_id, file_name, file_name_key) VALUES (?, ?, 'test.pdf', 'test.pdf')").bind(scoreId, choirId).run();
    const layers = await callWorker(`/api/choirs/${choirId}/scores/${scoreId}/layers`, { headers: { cookie: member.cookie } });
    const layerId = (await layers.json() as { layers: { id: string }[] }).layers[0].id;
    const operation = { opId: crypto.randomUUID(), annotationId: crypto.randomUUID(), layerId, baseVersion: 0, type: "upsert", payload: { kind: "text", pageNumber: 1, x: 0.2, y: 0.2, fontScale: 0.024, text: "离线草稿" } };
    let intercepted = false;
    const binding = new Proxy(env.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          expect((await post(`/api/choirs/${choirId}/memberships/${membership.id}`, admin.cookie, { action: "remove", expectedRevision: 0 })).status).toBe(204);
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const request = () => new Request(`https://same-page.test/api/choirs/${choirId}/scores/${scoreId}/annotations/push`, {
      method: "POST", headers: { cookie: member.cookie, "content-type": "application/json", "x-same-page-owner-user-id": member.id }, body: JSON.stringify({ operations: [operation] }),
    });
    const ctx = createExecutionContext();
    const rejected = await worker.fetch(request(), { ...env, DB: binding }, ctx); await waitOnExecutionContext(ctx);
    expect(intercepted).toBe(true); expect(rejected.status).toBe(403);
    expect((await post(`/api/choirs/${choirId}/memberships/${membership.id}`, admin.cookie, { action: "restore", expectedRevision: 1 })).status).toBe(204);
    const acceptedCtx = createExecutionContext();
    const accepted = await worker.fetch(request(), env, acceptedCtx); await waitOnExecutionContext(acceptedCtx);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ results: [{ opId: operation.opId, status: "accepted" }] });
    const adminLayers = await callWorker(`/api/choirs/${choirId}/scores/${scoreId}/layers`, { headers: { cookie: admin.cookie } });
    expect((await adminLayers.json() as { layers: { id: string }[] }).layers.some((layer) => layer.id === layerId)).toBe(false);
  });

  it("purges identity and personal layers but retains shared objects and their pull history", async () => {
    const admin = await person("admin@example.test"); const member = await person("member@example.test");
    const choirId = await drive(admin, member);
    const scoreId = crypto.randomUUID(), shared = crypto.randomUUID(), personal = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO scores (id, choir_id, file_name, file_name_key) VALUES (?, ?, 'test.pdf', 'test.pdf')").bind(scoreId, choirId).run();
    await env.DB.prepare(`INSERT INTO annotation_layers (id, choir_id, score_id, kind, owner_user_id, default_slot, name, default_color)
      VALUES (?, ?, ?, 'shared', NULL, 'E', 'Ensemble', '#000000'), (?, ?, ?, 'personal', ?, NULL, 'Personal', '#000000')`)
      .bind(shared, choirId, scoreId, personal, choirId, scoreId, member.id).run();
    const objectId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO annotation_objects (id, choir_id, score_id, layer_id, version, deleted, payload_json,
      created_by_user_id, updated_by_user_id, created_by_display_name, updated_by_display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, '旧名', '旧名', 1, 1)`).bind(objectId, choirId, scoreId, shared,
      JSON.stringify({ kind: "text", pageNumber: 1, x: 0.1, y: 0.2, fontScale: 0.024, text: "保留" }), member.id, member.id).run();
    await env.DB.prepare(`INSERT INTO annotation_sync_operations (op_id, choir_id, score_id, layer_id, annotation_id, actor_user_id,
      base_version, operation_type, payload_hash, status, resulting_version, created_at)
      VALUES ('retained-operation', ?, ?, ?, ?, ?, 0, 'upsert', 'hash', 'accepted', 1, 1)`).bind(choirId, scoreId, shared, objectId, member.id).run();
    const beforePull = await callWorker(`/api/choirs/${choirId}/scores/${scoreId}/annotations`, { headers: { cookie: admin.cookie } });
    const cursor = (await beforePull.json() as { cursor: number }).cursor;
    const fresh = await reauthenticate(member);
    expect((await post("/api/user/lifecycle/delete", fresh, { confirm: true, expectedUserId: member.id })).status).toBe(204);
    const changed = await callWorker(`/api/choirs/${choirId}/scores/${scoreId}/annotations?cursor=${cursor}`, { headers: { cookie: admin.cookie } });
    expect(await changed.json()).toMatchObject({ objects: [{ id: objectId, createdByDisplayName: "成员乙" }] });
    await cleanupLifecycles(env, Date.now() + RECOVERY_PERIOD_MS + 1);
    await cleanupLifecycles(env, Date.now() + RECOVERY_PERIOD_MS + 1);
    expect(await env.DB.prepare("SELECT id FROM user WHERE id = ?").bind(member.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM annotation_layers WHERE id = ?").bind(personal).first()).toBeNull();
    expect(await env.DB.prepare("SELECT created_by_display_name, created_by_user_id FROM annotation_objects WHERE id = ?").bind(objectId).first()).toEqual({ created_by_display_name: "成员乙", created_by_user_id: null });
    expect(await env.DB.prepare("SELECT actor_user_id FROM annotation_sync_operations WHERE op_id = 'retained-operation'").first()).toEqual({ actor_user_id: null });
    const pull = await callWorker(`/api/choirs/${choirId}/scores/${scoreId}/annotations`, { headers: { cookie: admin.cookie } });
    expect(pull.status).toBe(200);
    expect(await pull.json()).toMatchObject({ objects: [{ id: objectId, createdByDisplayName: "成员乙" }] });
  });
});

it("updates only the caller's drive display name and guards administrator renaming with revisions", async () => {
  const admin = await person("rename-admin@example.test");
  const member = await person("rename-member@example.test");
  const choirId = await drive(admin, member);
  const otherId = await drive(admin, member);
  const settings = async (id: string, cookie: string) => (await callWorker(`/api/choirs/${id}/settings`, { headers: { cookie } })).json() as Promise<{ name: string; nameRevision: number; displayName: string; membershipRevision: number }>;
  const before = await settings(choirId, member.cookie);
  expect(before.displayName).toBe("成员乙");
  const patch = (path: string, cookie: string, body: unknown) => callWorker(path, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const path = `/api/choirs/${choirId}`;
  expect((await patch(`${path}/display-name`, member.cookie, { displayName: " 新名字 ", expectedRevision: before.membershipRevision })).status).toBe(200);
  expect((await settings(choirId, member.cookie)).displayName).toBe("新名字");
  expect((await settings(otherId, member.cookie)).displayName).toBe("成员乙");
  expect((await settings(choirId, admin.cookie)).displayName).toBe("管理员甲");
  expect((await patch(`${path}/display-name`, member.cookie, { displayName: "过期写入", expectedRevision: before.membershipRevision })).status).toBe(409);
  expect((await patch(`${path}/name`, member.cookie, { name: "越权", expectedRevision: before.nameRevision })).status).toBe(403);
  const results = await Promise.all(["新云盘", "另一名称"].map(name => patch(`${path}/name`, admin.cookie, { name, expectedRevision: before.nameRevision })));
  expect(results.map(result => result.status).sort()).toEqual([200, 409]);
  const after = await settings(choirId, admin.cookie);
  expect(after.nameRevision).toBe(before.nameRevision + 1);
  expect(["新云盘", "另一名称"]).toContain(after.name);
  expect((await patch(`${path}/name`, admin.cookie, { name: "  ", expectedRevision: after.nameRevision })).status).toBe(400);
});

it("allows only one concurrent ownership transfer and protects the new owner", async () => {
  const a = await person("handoff-a@example.test"); const b = await person("handoff-b@example.test");
  const c = await person("handoff-c@example.test");
  const choirId = await drive(a, b);
  await env.DB.prepare("INSERT INTO memberships (id, choir_id, user_id, display_name) VALUES (?, ?, ?, '丙')").bind(crypto.randomUUID(), choirId, c.id).run();
  const bMember = (await state(b.cookie)).memberships[0]; const cMember = (await state(c.cookie)).memberships[0];
  const responses = await Promise.all([bMember, cMember].map(member => post(`/api/choirs/${choirId}/ownership`, a.cookie, { membershipId: member.id, confirm: true })));
  expect(responses.filter(response => response.status === 204)).toHaveLength(1);
  const current = [...(await state(a.cookie)).memberships, ...(await state(b.cookie)).memberships, ...(await state(c.cookie)).memberships];
  expect(current.filter(member => member.isOwner === 1 && member.status === "active")).toHaveLength(1);
});

it("delegates only a bounded grant scope, protects trustees and keeps issued grants after revocation", async () => {
  const owner = await person("permissions-owner@example.test");
  const trustee = await person("permissions-trustee@example.test");
  const target = await person("permissions-target@example.test");
  const choirId = await drive(owner, trustee);
  await env.DB.prepare("INSERT INTO memberships (id, choir_id, user_id, display_name) VALUES (?, ?, ?, '目标')").bind(crypto.randomUUID(), choirId, target.id).run();
  const trusteeId = (await state(trustee.cookie)).memberships[0].id;
  const targetId = (await state(target.cookie)).memberships[0].id;
  const empty = { operations: [], sharedLayers: [] };
  const update = (cookie: string, id: string, expectedRevision: number, operations: object, management: object = empty) => callWorker(`/api/choirs/${choirId}/memberships/${id}/permissions`, {
    method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, operations, management }),
  });
  expect((await update(owner.cookie, trusteeId, 0, empty, { operations: ["manageInvites"], sharedLayers: ["S"] })).status).toBe(204);
  expect((await callWorker(`/api/choirs/${choirId}/join-code`, { headers: { cookie: trustee.cookie } })).status).toBe(403);
  expect((await update(trustee.cookie, trusteeId, 1, { operations: ["manageInvites"], sharedLayers: [] })).status).toBe(403);
  expect((await update(trustee.cookie, targetId, 0, { operations: ["modifyFiles"], sharedLayers: [] })).status).toBe(403);
  expect((await update(trustee.cookie, targetId, 0, { operations: [], sharedLayers: "all" })).status).toBe(403);
  expect((await update(trustee.cookie, targetId, 0, empty, { operations: ["manageInvites"], sharedLayers: [] })).status).toBe(403);
  expect((await update(trustee.cookie, targetId, 0, { operations: ["manageInvites"], sharedLayers: ["S"] })).status).toBe(204);
  expect((await update(owner.cookie, trusteeId, 1, empty)).status).toBe(204);
  expect((await callWorker(`/api/choirs/${choirId}/join-code`, { headers: { cookie: target.cookie } })).status).toBe(200);
  expect((await update(trustee.cookie, targetId, 1, empty)).status).toBe(403);
  const audit = await callWorker(`/api/choirs/${choirId}/permission-changes`, { headers: { cookie: owner.cookie } });
  const history = await audit.json() as { changes: unknown[] };
  expect(history.changes).toHaveLength(3);
  expect((await post(`/api/choirs/${choirId}/memberships/${targetId}`, owner.cookie, { action: "remove", expectedRevision: 1 })).status).toBe(204);
  expect((await post(`/api/choirs/${choirId}/memberships/${targetId}`, owner.cookie, { action: "restore", expectedRevision: 2 })).status).toBe(204);
  expect((await callWorker(`/api/choirs/${choirId}/join-code`, { headers: { cookie: target.cookie } })).status).toBe(403);
});

it("rejects future revisions before authorizing a permission update", async () => {
  const owner = await person("future-owner@example.test"); const target = await person("future-target@example.test");
  const choirId = await drive(owner, target); const member = (await state(target.cookie)).memberships[0];
  const response = await callWorker(`/api/choirs/${choirId}/memberships/${member.id}/permissions`, { method: "PUT", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: member.revision + 1, operations: { operations: ["uploadFiles"], sharedLayers: [] }, management: { operations: [], sharedLayers: [] } }) });
  expect(response.status).toBe(409);
});

it("rejects an owner's permission write when ownership changed between authorization reads", async () => {
  const owner = await person("race-owner@example.test"); const successor = await person("race-successor@example.test");
  const choirId = await drive(owner, successor);
  const own = (await state(owner.cookie)).memberships[0]; const target = (await state(successor.cookie)).memberships[0];
  let transferred = false;
  const DB = new Proxy(env.DB, { get(db, key) {
    if (key === "prepare") return (sql: string) => {
      if (sql === "SELECT owner_membership_id FROM choirs WHERE id = ?") return { bind: (...args: unknown[]) => ({ first: async () => {
        transferred = true;
        expect((await post(`/api/choirs/${choirId}/ownership`, owner.cookie, { membershipId: target.id, confirm: true })).status).toBe(204);
        return db.prepare(sql).bind(...args).first();
      } }) };
      return db.prepare(sql);
    };
    const value = Reflect.get(db, key); return typeof value === "function" ? value.bind(db) : value;
  }});
  const execution = createExecutionContext();
  const response = await worker.fetch(new Request(`https://same-page.test/api/choirs/${choirId}/memberships/${own.id}/permissions`, { method: "PUT", headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: own.revision, operations: { operations: ["manageInvites"], sharedLayers: [] }, management: { operations: ["manageInvites"], sharedLayers: [] } }) }), { ...env, DB }, execution);
  await waitOnExecutionContext(execution);
  expect(transferred).toBe(true); expect(response.status).toBe(409);
  expect((await callWorker(`/api/choirs/${choirId}/join-code`, { headers: { cookie: owner.cookie } })).status).toBe(403);
});
