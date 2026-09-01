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
      const body = (await request.json()) as { subject: string };
      deliveredOtp = body.subject.slice(0, 6);
      return HttpResponse.json({ id: crypto.randomUUID() });
    }),
  );
  await env.DB.batch(
    [
      "DELETE FROM annotation_sync_operations",
      "DELETE FROM annotation_objects",
      "DELETE FROM annotation_layer_preferences",
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

  it("enforces revoked grants, choir boundaries, personal privacy and guest read-only access", async () => {
    const fixture = await createFixture();
    const member = await createMember(fixture.joinCode!, "member@example.test", "小王");
    const memberRow = await createDatabase(env.DB).query.memberships.findFirst({
      where: eq(memberships.userId, member.userId),
    });
    const grantPath = `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/layers/${fixture.layerId}/grants/${memberRow!.id}`;
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
    expect(revoked.status).toBe(403);

    const memberLayers = await callWorker(
      `/api/choirs/${fixture.choirId}/scores/${fixture.scoreId}/layers`,
      { headers: { cookie: member.cookie } },
    );
    const memberLayerBody = (await memberLayers.json()) as {
      layers: Array<{ id: string; kind: string }>;
    };
    const memberPersonal = memberLayerBody.layers.find((layer) => layer.kind === "personal")!;
    const adminPersonalAttempt = await push(fixture, [
      operation(crypto.randomUUID(), memberPersonal.id, 0, "管理员也不能看"),
    ]);
    expect(adminPersonalAttempt.status).toBe(404);

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
    jsonRequest(admin.cookie, { name: "指挥批注", defaultColor: "#a12652", sortOrder: 0 }),
  );
  const layerId = ((await layerResponse.json()) as { layer: { id: string } }).layer.id;
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
