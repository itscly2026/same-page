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
import { choirs, user } from "./db/schema";
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

describe("score management and PDF delivery", () => {
  it("uploads, publishes, ranges, replaces, archives and enforces quota", async () => {
    const { adminCookie, choirId, joinCode } = await createAdminChoir();

    const invalidResponse = await callWorker(
      `/api/choirs/${choirId}/scores`,
      uploadRequest(new TextEncoder().encode("not a pdf"), {
        cookie: adminCookie,
        title: "损坏文件",
      }),
    );
    expect(invalidResponse.status).toBe(422);
    expect(await invalidResponse.json()).toEqual({ error: "invalid_pdf" });

    const originalPdf = createMinimalPdf(612, 792);
    const uploadResponse = await callWorker(
      `/api/choirs/${choirId}/scores`,
      uploadRequest(originalPdf, {
        cookie: adminCookie,
        title: "练声曲",
        composer: "作曲者",
      }),
    );
    expect(uploadResponse.status).toBe(201);
    const created = (await uploadResponse.json()) as {
      score: {
        id: string;
        currentVersion: { id: string; etag: string; sha256: string };
      };
    };
    expect(created.score.currentVersion.sha256).toMatch(/^[a-f0-9]{64}$/);

    const disposableResponse = await callWorker(
      `/api/choirs/${choirId}/scores`,
      uploadRequest(createMinimalPdf(400, 400), {
        cookie: adminCookie,
        title: "待删除草稿",
      }),
    );
    const disposable = (await disposableResponse.json()) as {
      score: { id: string };
    };
    const deleteDraftResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${disposable.score.id}`,
      { method: "DELETE", headers: { cookie: adminCookie } },
    );
    expect(deleteDraftResponse.status).toBe(204);
    expect((await env.SCORES_BUCKET.list()).objects).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM score_object_deletions",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const adminList = await callWorker(`/api/choirs/${choirId}/scores`, {
      headers: { cookie: adminCookie },
    });
    expect(await adminList.json()).toMatchObject({
      permissions: { canManage: true },
      scores: [{ id: created.score.id, status: "draft", title: "练声曲" }],
      storage: { usedBytes: originalPdf.byteLength, limitBytes: 1_073_741_824 },
    });

    const guestCookie = await createGuestCookie(joinCode!);
    const guestDraftList = await callWorker(`/api/choirs/${choirId}/scores`, {
      headers: { cookie: guestCookie },
    });
    expect(await guestDraftList.json()).toMatchObject({
      permissions: { canManage: false },
      scores: [],
    });

    const publishResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${created.score.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "published", sortOrder: 4 }),
      },
    );
    expect(publishResponse.status).toBe(200);

    const guestList = await callWorker(
      `/api/choirs/${choirId}/scores?q=${encodeURIComponent("作曲")}`,
      { headers: { cookie: guestCookie } },
    );
    expect(await guestList.json()).toMatchObject({
      scores: [{ id: created.score.id, status: "published" }],
    });

    const pdfPath = `/api/choirs/${choirId}/scores/${created.score.id}/pdf`;
    const rangeResponse = await callWorker(pdfPath, {
      headers: { cookie: guestCookie, Range: "bytes=0-7" },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("Accept-Ranges")).toBe("bytes");
    expect(rangeResponse.headers.get("Content-Range")).toBe(
      `bytes 0-7/${originalPdf.byteLength}`,
    );
    expect(
      new TextDecoder().decode(await rangeResponse.arrayBuffer()),
    ).toBe("%PDF-1.4");

    const notModified = await callWorker(pdfPath, {
      headers: {
        cookie: guestCookie,
        "If-None-Match": created.score.currentVersion.etag,
      },
    });
    expect(notModified.status).toBe(304);

    const replacementPdf = createMinimalPdf(595, 842);
    const replaceResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${created.score.id}/versions`,
      uploadRequest(replacementPdf, { cookie: adminCookie }),
    );
    expect(replaceResponse.status).toBe(201);
    const replaced = (await replaceResponse.json()) as {
      version: { id: string; versionNumber: number };
    };
    expect(replaced.version.versionNumber).toBe(2);
    const retained = await env.DB.prepare(
      "SELECT retention_expires_at FROM score_versions WHERE id = ?",
    )
      .bind(created.score.currentVersion.id)
      .first<{ retention_expires_at: number }>();
    expect(retained?.retention_expires_at).toBeGreaterThan(
      Date.now() + 29 * 24 * 60 * 60 * 1000,
    );

    const oldVersionResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${created.score.id}/versions/${created.score.currentVersion.id}/pdf`,
      { headers: { cookie: guestCookie } },
    );
    expect(oldVersionResponse.status).toBe(200);
    expect((await oldVersionResponse.arrayBuffer()).byteLength).toBe(
      originalPdf.byteLength,
    );

    const choirAfterReplacement = await createDatabase(
      env.DB,
    ).query.choirs.findFirst({ where: eq(choirs.id, choirId) });
    expect(choirAfterReplacement?.storageUsedBytes).toBe(
      originalPdf.byteLength + replacementPdf.byteLength,
    );

    await env.DB.prepare(
      "UPDATE choirs SET storage_limit_bytes = storage_used_bytes WHERE id = ?",
    )
      .bind(choirId)
      .run();
    const quotaResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${created.score.id}/versions`,
      uploadRequest(createMinimalPdf(300, 300), { cookie: adminCookie }),
    );
    expect(quotaResponse.status).toBe(409);
    expect(await quotaResponse.json()).toEqual({
      error: "storage_quota_exceeded",
    });

    const archiveResponse = await callWorker(
      `/api/choirs/${choirId}/scores/${created.score.id}`,
      {
        method: "PATCH",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "archived" }),
      },
    );
    expect(archiveResponse.status).toBe(200);
    const archivedGuestList = await callWorker(
      `/api/choirs/${choirId}/scores`,
      { headers: { cookie: guestCookie } },
    );
    expect(await archivedGuestList.json()).toMatchObject({ scores: [] });
  });
});

async function createAdminChoir() {
  const email = "score-admin@example.test";
  const registration = await registerWithPassword({
    callWorker,
    email,
    latestOtp: () => deliveredOtp,
  });
  const database = createDatabase(env.DB);
  const admin = await database.query.user.findFirst({
    where: eq(user.email, email),
  });
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

function uploadRequest(
  data: Uint8Array,
  options: {
    cookie: string;
    title?: string;
    composer?: string;
  },
): RequestInit {
  const form = new FormData();
  form.set("file", new File([data], "score.pdf", { type: "application/pdf" }));
  if (options.title) form.set("title", options.title);
  if (options.composer) form.set("composer", options.composer);
  return { method: "POST", headers: { cookie: options.cookie }, body: form };
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
