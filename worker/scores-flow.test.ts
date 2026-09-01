import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
      const body = (await request.json()) as { subject: string };
      deliveredOtp = body.subject.slice(0, 6);
      return HttpResponse.json({ id: crypto.randomUUID() });
    }),
  );
  await env.DB.batch(
    [
      "DELETE FROM score_object_deletions",
      "DELETE FROM annotation_sync_operations",
      "DELETE FROM annotation_objects",
      "DELETE FROM annotation_layer_preferences",
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
      ["G", "S", "A", "T", "B"].map((slot) => ({
        default_slot: slot,
        kind: "shared",
        name: slot,
      })),
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
    expect(guestPayload.scores.map((score) => score.fileName)).toEqual([
      "练习 2.pdf",
      "练习 10.pdf",
    ]);

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
      uploadRequest(createMinimalPdf(250, 250), adminCookie, "replacement.pdf"),
    );
    expect(quota.status).toBe(409);
    expect(await quota.json()).toEqual({ error: "storage_quota_exceeded" });

    expect(twoUpload.id).not.toBe(tenUpload.id);
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
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO annotation_layers
          (id, choir_id, score_id, kind, name, sort_order, default_color)
         VALUES ('trash-layer', ?, ?, 'shared', '指挥', 0, '#a12652')`,
      ).bind(choirId, original.id),
      env.DB.prepare(
        `INSERT INTO annotation_objects
          (id, choir_id, score_id, layer_id, version, deleted, payload_json,
           created_by_display_name, updated_by_display_name, created_at, updated_at)
         VALUES ('trash-annotation', ?, ?, 'trash-layer', 1, 0, ?,
                 '管理员', '管理员', 1, 1)`,
      ).bind(
        choirId,
        original.id,
        JSON.stringify({ kind: "text", pageNumber: 1, x: 0.1, y: 0.1, fontScale: 0.024, text: "保留" }),
      ),
    ]);
    const historicalPdf = createMinimalPdf(595, 842);
    expect(
      (
        await callWorker(
          `/api/choirs/${choirId}/scores/${original.id}/versions`,
          uploadRequest(historicalPdf, adminCookie, "replacement.pdf"),
        )
      ).status,
    ).toBe(201);
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

function uploadRequest(data: Uint8Array, cookie: string, fileName: string): RequestInit {
  const form = new FormData();
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

async function callWorker(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://same-page.test${path}`, init),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
