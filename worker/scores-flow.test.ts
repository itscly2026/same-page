import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "./index";
import { provisionChoir } from "./choirs/provision";
import { createDatabase } from "./db/database";
import { choirs, user } from "./db/schema";
import { cleanupScoreStorage } from "./scores/cleanup";
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
      "DELETE FROM score_object_deletions",
      "DELETE FROM annotation_sync_operations",
      "DELETE FROM annotation_objects",
      "DELETE FROM user_score_layer_preferences",
      "DELETE FROM user_drive_layer_preferences",
      "DELETE FROM annotation_layers",
      "DELETE FROM shared_layer_edit_grants",
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
  await clearBucket();
});

afterEach(() => network.resetHandlers());

describe("PDF file library and delivery", () => {
  it("does not truncate literal long filename searches on either library endpoint", async () => {
    const { adminCookie, choirId } = await createAdminChoir();
    const name = "合唱排练".repeat(31) + "%_结尾.pdf";
    const score = await upload(choirId, adminCookie, name, createMinimalPdf(200, 200));
    for (const endpoint of ["scores", "bootstrap"]) {
      for (const [query, matches] of [[name, true], ["%_", true], ["\\", false], ["合唱排练".repeat(31) + "不匹配", false]] as const) {
        const response = await callWorker(`/api/choirs/${choirId}/${endpoint}?q=${encodeURIComponent(query)}`, { headers: { cookie: adminCookie } });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ scores: matches ? [{ id: score.id }] : [] });
      }
    }
  });

  it.each([-1, 0, 1])("restores only strictly before expiration (offset %i)", async (offset) => {
    const { adminCookie, choirId } = await createAdminChoir();
    const score = await upload(choirId, adminCookie, "期限.pdf", createMinimalPdf(200, 200));
    const now = Date.now();
    await env.DB.prepare("UPDATE scores SET trashed_at = ?, trash_expires_at = ? WHERE id = ?").bind(now - 30 * 86400000, now + offset, score.id).run();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const response = await callWorker(`/api/choirs/${choirId}/scores/${score.id}/restore`, { method: "POST", headers: { cookie: adminCookie } });
      expect(response.status).toBe(offset > 0 ? 204 : 404);
    } finally { clock.mockRestore(); }
  });

  it("excludes expired trash and refuses restoration before delayed cleanup", async () => {
    const { adminCookie, choirId } = await createAdminChoir();
    const score = await upload(choirId, adminCookie, "过期.pdf", createMinimalPdf(200, 200));
    await callWorker(`/api/choirs/${choirId}/scores/${score.id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    await env.DB.prepare("UPDATE scores SET trashed_at = ?, trash_expires_at = ? WHERE id = ?").bind(Date.now() - 31 * 86400000, Date.now() - 86400000, score.id).run();
    const list = await callWorker(`/api/choirs/${choirId}/scores/trash`, { headers: { cookie: adminCookie } });
    expect(await list.json()).toMatchObject({ scores: [] });
    const restored = await callWorker(`/api/choirs/${choirId}/scores/${score.id}/restore`, { method: "POST", headers: { cookie: adminCookie } });
    expect(restored.status).toBe(404);
    await cleanupScoreStorage(env);
    expect((await callWorker(`/api/choirs/${choirId}/scores/${score.id}/restore`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(404);
  });

  it("uses file names, exposes validated uploads immediately, and preserves replacement delivery", async () => {
    const { adminCookie, choirId, joinCode } = await createAdminChoir();

    const invalidResponse = await callWorker(
      `/api/choirs/${choirId}/scores`,
      uploadRequest(new TextEncoder().encode("not a pdf"), adminCookie, "损坏.pdf"),
    );
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toEqual({ error: "invalid_pdf" });

    const tenPdf = createMinimalPdf(612, 792);
    const tenUpload = await upload(choirId, adminCookie, "练习 10.pdf", tenPdf);
    const twoUpload = await upload(
      choirId,
      adminCookie,
      "练习 2.pdf",
      createMinimalPdf(400, 400),
    );
    const defaultLayers = await env.DB.prepare(
      `SELECT default_slot, kind, name
       FROM annotation_layers
       WHERE score_id = ? AND default_slot IS NOT NULL
       ORDER BY sort_order`,
    )
      .bind(tenUpload.id)
      .all<{ default_slot: string; kind: string; name: string }>();
    expect(defaultLayers.results).toEqual(
      [
        ["E", "Ensemble"],
        ["S", "Soprano"],
        ["A", "Alto"],
        ["T", "Tenor"],
        ["B", "Bass"],
      ].map(([slot, name]) => ({ default_slot: slot, kind: "shared", name })),
    );

    const duplicate = await callWorker(
      `/api/choirs/${choirId}/scores`,
      uploadRequest(createMinimalPdf(300, 300), adminCookie, "练习 10.PDF"),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "filename_conflict" });

    const guestCookie = await createGuestCookie(joinCode!);
    const guestList = await callWorker(`/api/choirs/${choirId}/scores`, {
      headers: { cookie: guestCookie },
    });
    const guestPayload = (await guestList.json()) as {
      scores: Array<{ id: string; fileName: string }>;
      permissions: { canManage: boolean };
    };
    expect(guestPayload.permissions).toEqual({ canManage: false });
    expect(guestList.headers.get("Server-Timing")).toMatch(
      /auth;dur=.*access;dur=.*d1;dur=.*total;dur=/,
    );
    expect(guestPayload.scores.map((score) => score.fileName)).toEqual([
      "练习 2.pdf",
      "练习 10.pdf",
    ]);

    const driveBootstrap = await callWorker(`/api/choirs/${choirId}/bootstrap`, {
      headers: { cookie: guestCookie },
    });
    expect(await driveBootstrap.json()).toMatchObject({
      choir: { id: choirId, name: "小红花云盘", guestAdmissionMode: "invite" },
      scores: [{ fileName: "练习 2.pdf" }, { fileName: "练习 10.pdf" }],
      permissions: { canManage: false, access: "guest" },
    });
    expect(driveBootstrap.headers.get("Server-Timing")).toMatch(
      /auth;dur=.*access;dur=.*d1;dur=.*total;dur=/,
    );
    const filteredDriveBootstrap = await callWorker(
      `/api/choirs/${choirId}/bootstrap?q=${encodeURIComponent("10.PDF")}`,
      { headers: { cookie: guestCookie } },
    );
    expect(await filteredDriveBootstrap.json()).toMatchObject({
      choir: { id: choirId },
      scores: [{ id: tenUpload.id, fileName: "练习 10.pdf" }],
    });
    const emptyDriveBootstrap = await callWorker(
      `/api/choirs/${choirId}/bootstrap?q=${encodeURIComponent("没有结果")}`,
      { headers: { cookie: guestCookie } },
    );
    expect(emptyDriveBootstrap.status).toBe(200);
    expect(await emptyDriveBootstrap.json()).toMatchObject({
      choir: { id: choirId },
      scores: [],
    });

    const adminDriveBootstrap = await callWorker(
      `/api/choirs/${choirId}/bootstrap`,
      { headers: { cookie: adminCookie } },
    );
    expect(await adminDriveBootstrap.json()).toMatchObject({
      permissions: { canManage: true, access: "membership" },
    });

    const bootstrap = await callWorker(
      `/api/choirs/${choirId}/scores/${tenUpload.id}/bootstrap`,
      { headers: { cookie: guestCookie } },
    );
    expect(await bootstrap.json()).toMatchObject({
      state: "active",
      score: { id: tenUpload.id, fileName: "练习 10.pdf" },
      permissions: { canManage: false },
    });
    const adminBootstrap = await callWorker(
      `/api/choirs/${choirId}/scores/${tenUpload.id}/bootstrap`,
      { headers: { cookie: adminCookie } },
    );
    expect(await adminBootstrap.json()).toMatchObject({
      state: "active",
      permissions: { canManage: true },
    });
    const missingBootstrap = await callWorker(
      `/api/choirs/${choirId}/scores/missing/bootstrap`,
      { headers: { cookie: guestCookie } },
    );
    expect(missingBootstrap.status).toBe(404);

    const search = await callWorker(
      `/api/choirs/${choirId}/scores?q=${encodeURIComponent("10.PDF")}`,
      { headers: { cookie: guestCookie } },
    );
    expect(await search.json()).toMatchObject({
      scores: [{ id: tenUpload.id, fileName: "练习 10.pdf" }],
    });

    const pdfPath = `/api/choirs/${choirId}/scores/${tenUpload.id}/pdf`;
    const rangeResponse = await callWorker(pdfPath, {
      headers: { cookie: guestCookie, Range: "bytes=0-7" },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("Server-Timing")).toMatch(
      /auth;dur=.*access;dur=.*d1;dur=.*r2;dur=.*total;dur=/,
    );
    expect(rangeResponse.headers.get("Content-Range")).toBe(
      `bytes 0-7/${tenPdf.byteLength}`,
    );
    expect(new TextDecoder().decode(await rangeResponse.arrayBuffer())).toBe("%PDF-1.4");

    const rename = await renameScore(choirId, tenUpload.id, adminCookie, "排练曲.pdf");
    expect(rename.status).toBe(200);
    const renameConflict = await renameScore(
      choirId,
      tenUpload.id,
      adminCookie,
      "练习 2.PDF",
    );
    expect(renameConflict.status).toBe(409);

    const replacementPdf = createMinimalPdf(595, 842);
    const replacement = await callWorker(
      `/api/choirs/${choirId}/scores/${tenUpload.id}/versions`,
      uploadRequest(replacementPdf, adminCookie, "replacement.pdf"),
    );
    expect(replacement.status).toBe(201);
    const replacementPayload = (await replacement.json()) as {
      version: { id: string; versionNumber: number };
    };
    expect(replacementPayload.version.versionNumber).toBe(2);
    expect((await publishVersion(choirId, tenUpload.id, replacementPayload.version.id, adminCookie, 1)).status).toBe(204);
    const oldVersion = await callWorker(
      `/api/choirs/${choirId}/scores/${tenUpload.id}/versions/${tenUpload.versionId}/pdf`,
      { headers: { cookie: guestCookie } },
    );
    expect(oldVersion.status).toBe(200);
    expect((await oldVersion.arrayBuffer()).byteLength).toBe(tenPdf.byteLength);

    const choir = await createDatabase(env.DB).query.choirs.findFirst({
      where: eq(choirs.id, choirId),
    });
    expect(choir?.storageUsedBytes).toBeGreaterThan(replacementPdf.byteLength);
    await env.DB.prepare(
      "UPDATE choirs SET storage_limit_bytes = storage_used_bytes WHERE id = ?",
    )
      .bind(choirId)
      .run();
    const quota = await callWorker(
      `/api/choirs/${choirId}/scores/${tenUpload.id}/versions`,
      uploadRequest(createMinimalPdf(250, 250), adminCookie, "replacement.pdf", 2),
    );
    expect(quota.status).toBe(409);
    expect(await quota.json()).toEqual({ error: "storage_quota_exceeded" });

    expect(twoUpload.id).not.toBe(tenUpload.id);
  });

  it("stages, cancels, publishes and rolls back with revision and retention guards", async () => {
    const { adminCookie, choirId, joinCode } = await createAdminChoir();
    const guestCookie = await createGuestCookie(joinCode!);
    const original = await upload(choirId, adminCookie, "原版.pdf", createMinimalPdf(400, 400));
    const path = `/api/choirs/${choirId}/scores/${original.id}`;
    const headers = { cookie: adminCookie };
    const history = async () => (await callWorker(`${path}/versions`, { headers })).json();
    const current = async () => (await callWorker(`${path}/pdf`, { headers })).headers.get("X-Score-Version");
    const stage = async (revision: number) => {
      const response = await callWorker(`${path}/versions`, uploadRequest(createMinimalPdf(500, 600), adminCookie, "候选.pdf", revision));
      expect(response.status).toBe(201);
      return (await response.json() as { version: { id: string; versionNumber: number } }).version;
    };
    const first = await stage(1);
    expect(await current()).toBe(original.versionId);
    expect(await history()).toMatchObject({ revision: 1, versions: [{ id: original.versionId }] });
    expect((await callWorker(`${path}/versions/${first.id}/pdf`, { headers: { cookie: guestCookie } })).status).toBe(404);
    expect((await callWorker(`${path}/versions/${first.id}/pdf`, { headers })).status).toBe(200);
    expect((await publishVersion(choirId, original.id, first.id, guestCookie, 1)).status).toBe(403);
    expect((await callWorker(`${path}/versions/${first.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await callWorker(`${path}/versions/${first.id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await publishVersion(choirId, original.id, first.id, adminCookie, 1)).status).toBe(409);
    expect(await current()).toBe(original.versionId);
    const second = await stage(1);
    const competing = await stage(1);
    expect(second.versionNumber).toBe(3);
    const race = await Promise.all([
      publishVersion(choirId, original.id, second.id, adminCookie, 1),
      publishVersion(choirId, original.id, competing.id, adminCookie, 1),
    ]);
    expect(race.map((response) => response.status).sort()).toEqual([204, 409]);
    const winner = race[0].status === 204 ? second : competing;
    expect((await publishVersion(choirId, original.id, winner.id, adminCookie, 1)).status).toBe(204);
    expect(await history()).toMatchObject({ revision: 2, currentVersionId: winner.id });
    expect((await publishVersion(choirId, original.id, original.versionId, adminCookie, 2)).status).toBe(204);
    expect(await history()).toMatchObject({ revision: 3, currentVersionId: original.versionId });
    // ABA: returning to the original PDF cannot make an old publication valid again.
    expect((await publishVersion(choirId, original.id, competing.id, adminCookie, 1)).status).toBe(409);
    expect((await callWorker(`${path}/versions`, uploadRequest(createMinimalPdf(10, 10), adminCookie, "旧窗口.pdf", 1))).status).toBe(409);
    const expiring = await stage(3);
    await env.DB.prepare("UPDATE score_versions SET candidate_expires_at = ? WHERE id = ?").bind(Date.now() - 1, expiring.id).run();
    expect((await publishVersion(choirId, original.id, expiring.id, adminCookie, 3)).status).toBe(409);
    expect((await callWorker(`${path}/versions/${expiring.id}/pdf`, { headers })).status).toBe(404);
    await env.DB.prepare("UPDATE score_versions SET retention_expires_at = ? WHERE id = ?").bind(Date.now() - 1, winner.id).run();
    expect((await publishVersion(choirId, original.id, winner.id, adminCookie, 3)).status).toBe(409);
    const failingBucket = new Proxy(env.SCORES_BUCKET, { get(target, property) {
      if (property === "delete") return async () => { throw new Error("simulated_storage_failure"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(cleanupScoreStorage({ ...env, SCORES_BUCKET: failingBucket })).rejects.toThrow("simulated_storage_failure");
    await cleanupScoreStorage(env);
    await cleanupScoreStorage(env);
    expect(await current()).toBe(original.versionId);
    expect(await history()).toMatchObject({ versions: [{ id: original.versionId }] });
    expect((await callWorker(`${path}/versions/${winner.id}/pdf`, { headers })).status).toBe(404);
  });

  it("rejects a broken middle page before reserving storage", async () => {
    const { adminCookie, choirId } = await createAdminChoir();
    const broken = new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 99 0 R 4 0 R] /Count 3 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R >>
%%EOF`);
    const response = await callWorker(`/api/choirs/${choirId}/scores`, uploadRequest(broken, adminCookie, "中间页损坏.pdf"));
    expect(response.status).toBe(422);
    const list = await callWorker(`/api/choirs/${choirId}/scores`, { headers: { cookie: adminCookie } });
    expect(await list.json()).toMatchObject({ scores: [], storage: { usedBytes: 0 } });
  });

  it("keeps member priority while enforcing guest and membership revocation", async () => {
    const { adminCookie, choirId, joinCode } = await createAdminChoir();
    const guestCookie = await createGuestCookie(joinCode!);
    const preparedSql: string[] = [];
    const observedDatabase = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            preparedSql.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observedEnvironment = new Proxy(env, {
      get(target, property) {
        return property === "DB"
          ? observedDatabase
          : Reflect.get(target, property, target);
      },
    });
    const measuredGuestBootstrap = await callWorker(
      `/api/choirs/${choirId}/bootstrap`,
      { headers: { cookie: guestCookie } },
      observedEnvironment,
    );
    expect(measuredGuestBootstrap.status).toBe(200);
    expect(preparedSql).toHaveLength(1);
    expect(preparedSql[0]).toMatch(/LEFT JOIN memberships[\s\S]*LEFT JOIN scores/);
    expect(measuredGuestBootstrap.headers.get("Server-Timing")).toMatch(
      /auth;dur=.*access;dur=.*d1;dur=.*total;dur=/,
    );
    const nonmember = await registerWithPassword({
      callWorker,
      email: "score-nonmember@example.test",
      latestOtp: () => deliveredOtp,
    });

    const memberPriority = await callWorker(`/api/choirs/${choirId}/bootstrap`, {
      headers: { cookie: `${adminCookie}; ${guestCookie}` },
    });
    expect(await memberPriority.json()).toMatchObject({
      permissions: { canManage: true, access: "membership" },
    });

    const guestFallback = await callWorker(`/api/choirs/${choirId}/bootstrap`, {
      headers: { cookie: `${nonmember.cookie}; ${guestCookie}` },
    });
    expect(await guestFallback.json()).toMatchObject({
      permissions: { canManage: false, access: "guest" },
    });

    const rotation = await callWorker(`/api/choirs/${choirId}/join-code/rotate`, {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    const rotated = (await rotation.json()) as { joinCode: string };
    expect(rotation.status).toBe(200);
    expect(
      (await callWorker(`/api/choirs/${choirId}/bootstrap`, {
        headers: { cookie: guestCookie },
      })).status,
    ).toBe(403);

    const currentGuestCookie = await createGuestCookie(rotated.joinCode);
    const successor = await env.DB.prepare("SELECT id FROM user WHERE email = 'score-nonmember@example.test'").first<{ id: string }>();
    // Keep an administrator while testing revocation of the original member.
    await env.DB.prepare("INSERT INTO memberships (id, choir_id, user_id, display_name, role) VALUES (?, ?, ?, '接任管理员', 'admin')")
      .bind(crypto.randomUUID(), choirId, successor!.id).run();
    await env.DB.prepare("UPDATE memberships SET status = 'removed' WHERE choir_id = ? AND user_id <> ?")
      .bind(choirId, successor!.id).run();
    expect(
      (await callWorker(`/api/choirs/${choirId}/bootstrap`, {
        headers: { cookie: adminCookie },
      })).status,
    ).toBe(403);
    const removedMemberGuestFallback = await callWorker(
      `/api/choirs/${choirId}/bootstrap`,
      { headers: { cookie: `${adminCookie}; ${currentGuestCookie}` } },
    );
    expect(removedMemberGuestFallback.status).toBe(403);
  });

  it("moves files to trash, resolves restore conflicts, and automatically purges expired data", async () => {
    const { adminCookie, choirId, joinCode } = await createAdminChoir();
    const guestCookie = await createGuestCookie(joinCode!);
    const original = await upload(
      choirId,
      adminCookie,
      "同名.pdf",
      createMinimalPdf(612, 792),
    );
    const trashLayer = await env.DB.prepare(
      "SELECT id FROM annotation_layers WHERE score_id = ? AND default_slot = 'E'",
    ).bind(original.id).first<{ id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO annotation_objects
          (id, choir_id, score_id, layer_id, version, deleted, payload_json,
           created_by_display_name, updated_by_display_name, created_at, updated_at)
         VALUES ('trash-annotation', ?, ?, ?, 1, 0, ?,
                 '管理员', '管理员', 1, 1)`,
      ).bind(
        choirId,
        original.id,
        trashLayer!.id,
        JSON.stringify({ kind: "text", pageNumber: 1, x: 0.1, y: 0.1, fontScale: 0.024, text: "保留" }),
      ),
    ]);
    const historicalPdf = createMinimalPdf(595, 842);
    const historicalUpload = await callWorker(
      `/api/choirs/${choirId}/scores/${original.id}/versions`,
      uploadRequest(historicalPdf, adminCookie, "replacement.pdf"),
    );
    expect(historicalUpload.status).toBe(201);
    const historical = await historicalUpload.json() as { version: { id: string } };
    expect((await publishVersion(choirId, original.id, historical.version.id, adminCookie, 1)).status).toBe(204);
    await env.DB.prepare(
      "UPDATE score_versions SET retention_expires_at = ? WHERE id = ?",
    )
      .bind(Date.now() - 1, original.versionId)
      .run();

    const trashResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${original.id}`,
      { method: "DELETE", headers: { cookie: adminCookie } },
    );
    expect(trashResponse.status).toBe(204);
    expect((await env.SCORES_BUCKET.list()).objects).toHaveLength(2);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE choirs SET storage_used_bytes = storage_used_bytes + 100 WHERE id = ?",
      ).bind(choirId),
      env.DB.prepare(
        `INSERT INTO score_versions
          (id, choir_id, score_id, version_number, object_key, size_bytes,
           sha256, page_count, state, created_at)
         VALUES ('abandoned-trash-upload', ?, ?, 3, ?, 100, ?, 1, 'pending', ?)`,
      ).bind(
        choirId,
        original.id,
        `choirs/${choirId}/scores/${original.id}/versions/abandoned-trash-upload.pdf`,
        "b".repeat(64),
        Date.now() - 2 * 60 * 60 * 1000,
      ),
    ]);
    await cleanupScoreStorage(env, Date.now());
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM score_versions WHERE score_id = ?")
        .bind(original.id)
        .first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare("SELECT id FROM score_versions WHERE id = 'abandoned-trash-upload'")
        .first(),
    ).toBeNull();

    const guestList = await callWorker(`/api/choirs/${choirId}/scores`, {
      headers: { cookie: guestCookie },
    });
    expect(await guestList.json()).toMatchObject({ scores: [] });
    const status = await callWorker(
      `/api/choirs/${choirId}/scores/${original.id}/status`,
      { headers: { cookie: guestCookie } },
    );
    expect(await status.json()).toMatchObject({ state: "trashed" });
    const bootstrap = await callWorker(
      `/api/choirs/${choirId}/scores/${original.id}/bootstrap`,
      { headers: { cookie: guestCookie } },
    );
    expect(await bootstrap.json()).toMatchObject({ state: "trashed" });
    const trashedPdf = await callWorker(
      `/api/choirs/${choirId}/scores/${original.id}/pdf`,
      { headers: { cookie: guestCookie } },
    );
    expect(trashedPdf.status).toBe(404);

    const replacement = await upload(
      choirId,
      adminCookie,
      "同名.pdf",
      createMinimalPdf(500, 500),
    );
    const restoreConflict = await callWorker(
      `/api/choirs/${choirId}/scores/${original.id}/restore`,
      { method: "POST", headers: { cookie: adminCookie } },
    );
    expect(restoreConflict.status).toBe(409);
    expect(await restoreConflict.json()).toEqual({ error: "filename_conflict" });

    expect(
      (await renameScore(choirId, original.id, adminCookie, "同名（恢复）.pdf")).status,
    ).toBe(200);
    expect(
      (
        await callWorker(`/api/choirs/${choirId}/scores/${original.id}/restore`, {
          method: "POST",
          headers: { cookie: adminCookie },
        })
      ).status,
    ).toBe(204);

    await callWorker(`/api/choirs/${choirId}/scores/${original.id}`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    const expiredAt = Date.now() - 1;
    await env.DB.prepare(
      "UPDATE scores SET trashed_at = ?, trash_expires_at = ? WHERE id = ?",
    )
      .bind(expiredAt - 1, expiredAt, original.id)
      .run();
    expect(await cleanupScoreStorage(env, Date.now())).toBeGreaterThan(0);
    expect(
      await env.DB.prepare("SELECT id FROM scores WHERE id = ?").bind(original.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM score_versions WHERE score_id = ?")
        .bind(original.id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM annotation_objects WHERE score_id = ?")
        .bind(original.id)
        .first(),
    ).toBeNull();
    expect(
      (await env.SCORES_BUCKET.list()).objects.map((object) => object.key),
    ).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM score_object_deletions").first(),
    ).toEqual({ count: 0 });

    const activeList = await callWorker(`/api/choirs/${choirId}/scores`, {
      headers: { cookie: adminCookie },
    });
    expect(await activeList.json()).toMatchObject({
      scores: [{ id: replacement.id, fileName: "同名.pdf" }],
    });
  });
});

async function upload(
  choirId: string,
  cookie: string,
  fileName: string,
  data: Uint8Array,
) {
  const response = await callWorker(
    `/api/choirs/${choirId}/scores`,
    uploadRequest(data, cookie, fileName),
  );
  expect(response.status).toBe(201);
  const payload = (await response.json()) as {
    score: { id: string; fileName: string; currentVersion: { id: string } };
  };
  expect(payload.score.fileName).toBe(fileName);
  return { id: payload.score.id, versionId: payload.score.currentVersion.id };
}

function renameScore(choirId: string, scoreId: string, cookie: string, fileName: string) {
  return callWorker(`/api/choirs/${choirId}/scores/${scoreId}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ fileName }),
  });
}

async function createAdminChoir() {
  const email = "score-admin@example.test";
  const registration = await registerWithPassword({
    callWorker,
    email,
    latestOtp: () => deliveredOtp,
  });
  const database = createDatabase(env.DB);
  const admin = await database.query.user.findFirst({ where: eq(user.email, email) });
  const provisioned = await provisionChoir({
    binding: env.DB,
    adminUserId: admin!.id,
    adminDisplayName: "管理员",
    inviteSecret: env.INVITE_SECRET,
  });
  return {
    adminCookie: registration.cookie,
    choirId: provisioned.choirId,
    joinCode: provisioned.joinCode,
  };
}

async function createGuestCookie(joinCode: string) {
  const response = await callWorker("/api/guest/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": "192.0.2.10",
    },
    body: JSON.stringify({ admission: "invite", joinCode }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

function uploadRequest(data: Uint8Array, cookie: string, fileName: string, revision = 1): RequestInit {
  const form = new FormData();
  form.set("expectedRevision", String(revision));
  form.set("file", new File([data], fileName, { type: "application/pdf" }));
  return { method: "POST", headers: { cookie }, body: form };
}

function createMinimalPdf(width: number, height: number): Uint8Array {
  const encoder = new TextEncoder();
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] >>\nendobj\n`,
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

async function clearBucket() {
  let cursor: string | undefined;
  do {
    const listed = await env.SCORES_BUCKET.list({ cursor });
    await env.SCORES_BUCKET.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function callWorker(
  path: string,
  init: RequestInit = {},
  runtimeEnvironment: typeof env = env,
) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://same-page.test${path}`, init),
    runtimeEnvironment,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function publishVersion(choirId: string, scoreId: string, versionId: string, cookie: string, expectedRevision: number) {
  return callWorker(`/api/choirs/${choirId}/scores/${scoreId}/versions/${versionId}/publish`, {
    method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision }),
  });
}
