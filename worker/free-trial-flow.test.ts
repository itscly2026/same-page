import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { HttpResponse, http } from "msw";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import worker from "./index";
import { registerWithPassword } from "./test/auth";
import { provisionChoir } from "./choirs/provision";
import { cleanupScoreStorage } from "./scores/cleanup";
import { createScoreVersion, stageScoreVersion } from "./scores/storage";
const network = setupNetwork();
let otp = "";
beforeAll(() => network.enable());
afterAll(() => network.disable());
beforeEach(async () => {
  network.use(http.post("https://api.resend.com/emails", async ({ request }) => {
    const body = await request.json() as { text: string };
    otp = body.text.match(/验证码：([0-9]{6})/)?.[1] ?? "";
    return HttpResponse.json({ id: crypto.randomUUID() });
  }));
  await env.DB.batch(["DELETE FROM choirs", "DELETE FROM user", "DELETE FROM rate_limits", "DELETE FROM score_object_deletions",
    "UPDATE drive_platform_limits SET free_drive_limit = 100, retained_pdf_limit_bytes = 21474836480"].map(sql => env.DB.prepare(sql)));
});
afterEach(() => network.resetHandlers());
async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://same-page.test/api${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
function json(cookie: string, body: unknown): RequestInit { return { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }; }
async function identity(email = `${crypto.randomUUID()}@example.test`) {
  const { cookie } = await registerWithPassword({ callWorker: (path, init) => call(path.replace(/^\/api/, ""), init), email, latestOtp: () => otp });
  const user = await env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
  return { cookie, userId: user!.id };
}
async function trial(cookie: string) {
  const response = await call("/choirs", json(cookie, { name: "试用云盘", displayName: "拥有者" }));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { choirId: string }).choirId;
}
async function owner(drive: string) {
  return (await env.DB.prepare("SELECT owner_membership_id AS id FROM choirs WHERE id = ?").bind(drive).first<{ id: string }>())!.id;
}
async function upload(drive: string, index: number, bytes = 100) {
  const data = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  const sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
  return createScoreVersion({ env, choirId: drive, membershipId: await owner(drive), fileName: `${index}.pdf`, fileNameKey: `${index}.pdf`, pdf: { data, sizeBytes: bytes, pageCount: 1, sha256 } });
}
it("creates a verified invite-only trial with owner/default layers and rejects duplicate concurrent ownership", async () => {
  const { cookie } = await identity();
  const results = await Promise.all([1,2].map(() => call("/choirs", json(cookie, { name: "试用", displayName: "指挥" }))));
  expect(results.map(r => r.status).sort()).toEqual([201,409]);
  const drive = await env.DB.prepare("SELECT * FROM choirs").first();
  expect(drive).toMatchObject({ plan: "free", score_limit: 10, member_limit: 20, storage_limit_bytes: 52_428_800, guest_admission_mode: "invite", is_preview_entry: 0 });
  expect((await env.DB.prepare("SELECT count(*) AS n FROM choir_shared_layer_settings").first())?.n).toBe(5);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM memberships").first())?.n).toBe(1);
});
it("atomically claims the last global slot, leaves registration available, and reclaims it on drive deletion", async () => {
  const a = await identity(); const b = await identity();
  await env.DB.prepare("UPDATE drive_platform_limits SET free_drive_limit = 1").run();
  const responses = await Promise.all([a,b].map(user => call("/choirs", json(user.cookie, { name: "试用云盘", displayName: "我" }))));
  expect(responses.map(r => r.status).sort()).toEqual([201,409]);
  const winner = responses[0].status === 201 ? a : b;
  const loser = winner === a ? b : a;
  const drive = (await env.DB.prepare("SELECT id FROM choirs").first<{ id: string }>())!.id;
  expect((await call(`/choirs/${drive}/purge`, json(winner.cookie, { confirm: true, name: "错误" }))).status).toBe(409);
  expect((await call(`/choirs/${drive}/purge`, json(winner.cookie, { confirm: true, name: "试用云盘" }))).status).toBe(204);
  expect((await call(`/choirs/${drive}/bootstrap`, { headers: { cookie: winner.cookie } })).status).toBe(404);
  expect(await (await call("/choirs", { headers: { cookie: winner.cookie } })).json()).toEqual({ memberships: [] });
  await trial(loser.cookie);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM choirs").first())?.n).toBe(2);
  await cleanupScoreStorage(env, Date.now() + 31 * 86400000);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM choirs").first())?.n).toBe(1);
});
it("enforces file count on uploads and restores, releases capacity once and retains inaccessible data for 30 days", async () => {
  const a = await identity(); const drive = await trial(a.cookie);
  await env.DB.prepare("UPDATE choirs SET score_limit = 1 WHERE id = ?").bind(drive).run();
  const results = await Promise.allSettled([upload(drive,1), upload(drive,2)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const score = (await env.DB.prepare("SELECT id FROM scores").first<{ id: string }>())!.id;
  const path = `/choirs/${drive}/scores/${score}`;
  expect((await call(path, { method: "DELETE", headers: { cookie: a.cookie } })).status).toBe(204);
  await upload(drive,3);
  expect(await (await call(`${path}/restore`, json(a.cookie, {}))).json()).toEqual({ error: "score_limit_reached" });
  expect((await call(`${path}/purge`, json(a.cookie, { confirm: true }))).status).toBe(204);
  expect((await env.DB.prepare("SELECT storage_used_bytes AS n FROM choirs WHERE id = ?").bind(drive).first())?.n).toBe(100);
  const purged = await env.DB.prepare("SELECT purged_at AS at FROM scores WHERE id = ?").bind(score).first<{ at: number }>();
  for (const suffix of ["/pdf", "/bootstrap", "/status", "/versions", "/layers", "/restore", "/purge"]) {
    expect((await call(path+suffix, suffix === "/restore" || suffix === "/purge" ? json(a.cookie,{confirm:true}) : { headers: {cookie:a.cookie} })).status).toBe(404);
  }
  await cleanupScoreStorage(env, purged!.at + 29 * 86400000);
  expect(await env.DB.prepare("SELECT id FROM scores WHERE id = ?").bind(score).first()).not.toBeNull();
  await cleanupScoreStorage(env, purged!.at + 30 * 86400000);
  expect(await env.DB.prepare("SELECT id FROM scores WHERE id = ?").bind(score).first()).toBeNull();
  expect((await env.DB.prepare("SELECT storage_used_bytes AS n FROM choirs WHERE id = ?").bind(drive).first())?.n).toBe(100);
});
it("enforces member restoration/transfer limits and owner-only purge", async () => {
  const a = await identity(); const b = await identity(); const c = await identity();
  const drive = await trial(a.cookie); await trial(b.cookie);
  await env.DB.prepare("UPDATE choirs SET member_limit = 2 WHERE id = ?").bind(drive).run();
  const code = await (await call(`/choirs/${drive}/join-code`, { headers: {cookie:a.cookie} })).json() as {joinCode:string};
  const join = (cookie:string) => call("/choirs/join",json(cookie,{admission:"invite",joinCode:code.joinCode,displayName:"成员"}));
  expect((await join(b.cookie)).status).toBe(201);
  expect(await (await join(c.cookie)).json()).toEqual({error:"member_limit_reached"});
  const member = (await env.DB.prepare("SELECT id FROM memberships WHERE choir_id = ? AND user_id = ?").bind(drive,b.userId).first<{id:string}>())!.id;
  expect(await (await call(`/choirs/${drive}/ownership`,json(a.cookie,{confirm:true,membershipId:member}))).json()).toEqual({error:"owned_drive_limit_reached"});
  expect((await call(`/choirs/${drive}/purge`,json(b.cookie,{confirm:true,name:"试用云盘"}))).status).toBe(403);
  expect((await call(`/choirs/${drive}/memberships/${member}`,json(a.cookie,{action:"remove",expectedRevision:0}))).status).toBe(204);
  expect((await join(c.cookie)).status).toBe(201);
  expect(await (await call(`/choirs/${drive}/memberships/${member}`,json(a.cookie,{action:"restore",expectedRevision:1}))).json()).toEqual({error:"member_limit_reached"});
});
it("keeps configured drives intact and limits retained platform bytes independently of released user quota", async () => {
  const a = await identity();
  const existing = await provisionChoir({binding:env.DB,ownerUserId:a.userId,ownerDisplayName:"我",inviteSecret:env.INVITE_SECRET});
  expect(await env.DB.prepare("SELECT plan, storage_limit_bytes, score_limit FROM choirs WHERE id = ?").bind(existing.choirId).first()).toEqual({plan:"configured",storage_limit_bytes:1073741824,score_limit:null});
  const drive = await trial(a.cookie);
  const score = await upload(drive,1);
  await call(`/choirs/${drive}/scores/${score.scoreId}`,{method:"DELETE",headers:{cookie:a.cookie}});
  await call(`/choirs/${drive}/scores/${score.scoreId}/purge`,json(a.cookie,{confirm:true}));
  await env.DB.prepare("UPDATE drive_platform_limits SET retained_pdf_limit_bytes = 100").run();
  await expect(upload(drive,2)).rejects.toThrow("platform_storage_limit_reached");
  expect((await env.DB.prepare("SELECT storage_used_bytes AS n FROM choirs WHERE id = ?").bind(drive).first())?.n).toBe(0);
});
it("rejects unverified creation and stale identity headers without consuming a slot", async () => {
  const a = await identity();
  await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?").bind(a.userId).run();
  expect(await (await call("/choirs", json(a.cookie,{name:"试用",displayName:"我"}))).json()).toEqual({error:"identity_verification_required"});
  const init = json(a.cookie,{name:"试用",displayName:"我"});
  init.headers = {...init.headers,"x-same-page-owner-user-id":"previous-user"};
  expect(await (await call("/choirs",init)).json()).toEqual({error:"identity_changed"});
  expect((await env.DB.prepare("SELECT count(*) AS n FROM choirs").first())?.n).toBe(0);
});
it("only admits one concurrent join into the last member slot", async () => {
  const a=await identity();const b=await identity();const c=await identity();
  const drive=await trial(a.cookie);
  await env.DB.prepare("UPDATE choirs SET member_limit = 2 WHERE id = ?").bind(drive).run();
  const {joinCode}=await (await call(`/choirs/${drive}/join-code`,{headers:{cookie:a.cookie}})).json() as {joinCode:string};
  const responses=await Promise.all([b,c].map(user=>call("/choirs/join",json(user.cookie,{admission:"invite",joinCode,displayName:"成员"}))));
  expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE choir_id = ? AND status = 'active'").bind(drive).first())?.n).toBe(2);
});
it("keeps purged historical PDF inaccessible to reads, images and publication while preserving current notes", async () => {
  const a=await identity();const drive=await trial(a.cookie);const score=await upload(drive,1);
  const version=await stageScoreVersion({env,choirId:drive,scoreId:score.scoreId,membershipId:await owner(drive),currentVersionId:score.version.id,expectedRevision:1,
    pdf:{data:new Uint8Array(100).buffer,sizeBytes:100,pageCount:1,sha256:score.version.sha256}});
  const path=`/choirs/${drive}/scores/${score.scoreId}`;
  expect((await call(`${path}/versions/${version.id}/publish`,json(a.cookie,{expectedRevision:1}))).status).toBe(204);
  expect((await call(`${path}/versions/${version.id}/purge`,json(a.cookie,{confirm:true}))).status).toBe(409);
  expect((await call(`${path}/versions/${score.version.id}/purge`,json(a.cookie,{confirm:true}))).status).toBe(204);
  for(const suffix of ["pdf","images","images/generation/1/2048.png"]) expect((await call(`${path}/versions/${score.version.id}/${suffix}`,{headers:{cookie:a.cookie}})).status).toBe(404);
  expect((await call(`${path}/versions/${score.version.id}/publish`,json(a.cookie,{expectedRevision:2}))).status).toBe(404);
  expect((await call(`${path}/layers`,{headers:{cookie:a.cookie}})).status).toBe(200);
  expect((await call(`${path}/pdf`,{headers:{cookie:a.cookie}})).status).toBe(200);
  const history=await (await call(`${path}/versions`,{headers:{cookie:a.cookie}})).json() as {versions:unknown[]};
  expect(history.versions).toHaveLength(1);
  expect((await env.DB.prepare("SELECT storage_used_bytes AS n FROM choirs WHERE id = ?").bind(drive).first())?.n).toBe(100);
});
it("deleting a populated drive retains its objects yet revokes guest entry and permits owner identity deletion", async () => {
  const a=await identity();const drive=await trial(a.cookie);const score=await upload(drive,1);
  const {joinCode}=await (await call(`/choirs/${drive}/join-code`,{headers:{cookie:a.cookie}})).json() as {joinCode:string};
  const guest=await call("/guest/session",json("",{admission:"invite",joinCode}));
  const cookie=guest.headers.get("set-cookie")!.split(";",1)[0];
  expect((await call(`/choirs/${drive}/purge`,json(a.cookie,{confirm:true,name:"试用云盘"}))).status).toBe(204);
  expect((await call("/guest/session",{headers:{cookie}})).status).toBe(401);
  expect((await call("/guest/session",json("",{admission:"invite",joinCode}))).status).toBe(401);
  expect((await call(`/choirs/${drive}/scores/${score.scoreId}/annotations/push`,json(a.cookie,{}))).status).toBe(404);
  await env.DB.prepare("INSERT INTO user_lifecycle(user_id,deletion_id,auth_method,deleted_at,expires_at) VALUES (?,?,'credential',?,?)").bind(a.userId,crypto.randomUUID(),Date.now(),Date.now()+30*86400000).run();
  expect(await env.DB.prepare("SELECT id FROM score_versions WHERE id = ?").bind(score.version.id).first()).not.toBeNull();
  await cleanupScoreStorage(env,Date.now()+31*86400000);
  expect(await env.DB.prepare("SELECT id FROM score_versions WHERE id = ?").bind(score.version.id).first()).toBeNull();
});
it("restores an identity without overfilling a drive whose member slot was reused", async () => {
  const a=await identity();const b=await identity();const c=await identity();const drive=await trial(a.cookie);
  await env.DB.prepare("UPDATE choirs SET member_limit = 2 WHERE id = ?").bind(drive).run();
  const {joinCode}=await (await call(`/choirs/${drive}/join-code`,{headers:{cookie:a.cookie}})).json() as {joinCode:string};
  const join=(cookie:string)=>call("/choirs/join",json(cookie,{admission:"invite",joinCode,displayName:"成员"}));
  expect((await join(b.cookie)).status).toBe(201);
  await env.DB.prepare("INSERT INTO user_lifecycle(user_id,deletion_id,auth_method,deleted_at,expires_at) VALUES (?,?,'credential',?,?)").bind(b.userId,crypto.randomUUID(),Date.now(),Date.now()+30*86400000).run();
  expect((await join(c.cookie)).status).toBe(201);
  await env.DB.prepare("DELETE FROM user_lifecycle WHERE user_id = ?").bind(b.userId).run();
  expect(await env.DB.prepare("SELECT status, removed_for_deletion_id FROM memberships WHERE choir_id = ? AND user_id = ?").bind(drive,b.userId).first()).toEqual({status:"removed",removed_for_deletion_id:null});
  expect((await env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE choir_id = ? AND status = 'active'").bind(drive).first())?.n).toBe(2);
});
