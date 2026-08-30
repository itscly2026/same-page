import { setupNetwork } from "@msw/cloudflare";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import worker from "./index";
import {
  requireChoirRead,
  requirePersonalLayerOwner,
  requireSharedLayerEdit,
} from "./auth/authorization";
import { provisionChoir } from "./choirs/provision";
import { createDatabase } from "./db/database";
import {
  choirs,
  memberships,
  sharedLayerEditGrants,
  user,
} from "./db/schema";

const network = setupNetwork();
const deliveredEmails: Array<{
  subject: string;
  to: string;
  text: string;
}> = [];
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeAll(() => {
  network.enable();
});

afterAll(() => {
  network.disable();
});

beforeEach(async () => {
  deliveredEmails.length = 0;
  network.use(
    http.post("https://api.resend.com/emails", async ({ request }) => {
      deliveredEmails.push(
        (await request.json()) as (typeof deliveredEmails)[number],
      );
      return HttpResponse.json({ id: crypto.randomUUID() });
    }),
  );

  for (const method of ["log", "warn", "error"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => undefined));
  }

  await env.DB.batch(
    [
      "DELETE FROM score_object_deletions",
      "DELETE FROM score_versions",
      "DELETE FROM scores",
      "DELETE FROM shared_layer_edit_grants",
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

afterEach(() => {
  network.resetHandlers();
  for (const spy of consoleSpies.splice(0)) {
    spy.mockRestore();
  }
});

describe("authentication and choir boundaries", () => {
  it("runs OTP registration, guest access, rotation and member authorization", async () => {
    const adminEmail = "admin@example.test";
    const firstOtp = await requestOtp(adminEmail);
    const firstRequestBody = firstOtp.responseBody;
    await expectOtpStoredAsHash(firstOtp.otp);

    const adminCookie = await signIn(adminEmail, firstOtp.otp);
    const database = createDatabase(env.DB);
    const admin = await database.query.user.findFirst({
      where: eq(user.email, adminEmail),
    });
    expect(admin).toBeDefined();

    const provisioned = await provisionChoir({
      binding: env.DB,
      adminUserId: admin!.id,
      adminDisplayName: "管理员",
      inviteSecret: env.INVITE_SECRET,
      getRandomValues(array) {
        array.fill(0);
        return array;
      },
    });
    expect(provisioned.joinCode).toBe("AAAAAAAA");

    const existingOtp = await requestOtp(adminEmail);
    expect(existingOtp.responseBody).toBe(firstRequestBody);

    const guestResponse = await callWorker("/api/guest/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.1",
      },
      body: JSON.stringify({
        admission: "invite",
        joinCode: provisioned.joinCode!,
      }),
    });
    expect(guestResponse.status).toBe(200);
    const guestCookie = cookieFrom(guestResponse);
    expect(guestCookie).toContain("same_page_guest=");

    const guestSessionResponse = await callWorker("/api/guest/session", {
      headers: { cookie: guestCookie },
    });
    expect(await guestSessionResponse.json()).toEqual({
      choir: {
        id: provisioned.choirId,
        name: "小红花合唱团",
        guestAdmissionMode: "invite",
      },
    });

    const createChoirResponse = await callWorker("/api/choirs", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ name: "不应创建" }),
    });
    expect(createChoirResponse.status).toBe(404);

    const rotateResponse = await callWorker(
      `/api/choirs/${provisioned.choirId}/join-code/rotate`,
      { method: "POST", headers: { cookie: adminCookie } },
    );
    expect(rotateResponse.status).toBe(200);
    const rotated = (await rotateResponse.json()) as { joinCode: string };
    expect(rotated.joinCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const expiredGuestResponse = await callWorker("/api/guest/session", {
      headers: { cookie: guestCookie },
    });
    expect(expiredGuestResponse.status).toBe(401);

    const currentGuestResponse = await callWorker("/api/guest/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.2",
      },
      body: JSON.stringify({ admission: "invite", joinCode: rotated.joinCode }),
    });
    const currentGuestCookie = cookieFrom(currentGuestResponse);

    const memberEmail = "member@example.test";
    const memberOtp = await requestOtp(memberEmail);
    const memberCookie = await signIn(memberEmail, memberOtp.otp);
    const joinResponse = await callWorker("/api/choirs/join-current-guest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${memberCookie}; ${currentGuestCookie}`,
      },
      body: JSON.stringify({
        displayName: "小花",
      }),
    });
    expect(joinResponse.status).toBe(201);
    const joined = (await joinResponse.json()) as {
      membership: { id: string; role: string };
    };
    expect(joined.membership.role).toBe("member");
    expect(joinResponse.headers.get("set-cookie")).toContain(
      "same_page_guest=",
    );

    const choirListResponse = await callWorker("/api/choirs", {
      headers: { cookie: memberCookie },
    });
    expect(await choirListResponse.json()).toMatchObject({
      memberships: [
        {
          displayName: "小花",
          role: "member",
          choir: { id: provisioned.choirId, name: "小红花合唱团" },
        },
      ],
    });

    const secondChoir = await provisionChoir({
      binding: env.DB,
      adminUserId: admin!.id,
      adminDisplayName: "管理员",
      choirName: "第二合唱团",
      inviteSecret: env.INVITE_SECRET,
      getRandomValues(array) {
        array.fill(1);
        return array;
      },
    });
    const secondJoinResponse = await callWorker("/api/choirs/join", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: memberCookie,
        "CF-Connecting-IP": "198.51.100.3",
      },
      body: JSON.stringify({
        admission: "invite",
        joinCode: secondChoir.joinCode,
        displayName: "小花二团",
      }),
    });
    expect(secondJoinResponse.status).toBe(201);

    const multiChoirResponse = await callWorker("/api/choirs", {
      headers: { cookie: memberCookie },
    });
    const multiChoirPayload = (await multiChoirResponse.json()) as {
      memberships: Array<{ choir: { id: string }; displayName: string }>;
    };
    expect(multiChoirPayload.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "小花",
          choir: expect.objectContaining({ id: provisioned.choirId }),
        }),
        expect.objectContaining({
          displayName: "小花二团",
          choir: expect.objectContaining({ id: secondChoir.choirId }),
        }),
      ]),
    );

    const choirWithOpenGuestAdmission = await provisionChoir({
      binding: env.DB,
      adminUserId: admin!.id,
      adminDisplayName: "管理员",
      choirName: "公开合唱团",
      guestAdmissionMode: "open",
      inviteSecret: env.INVITE_SECRET,
      getRandomValues(array) {
        array.fill(2);
        return array;
      },
    });
    expect(choirWithOpenGuestAdmission.joinCode).toBeNull();
    const persistedChoirWithOpenGuestAdmission =
      await database.query.choirs.findFirst({
        where: eq(choirs.id, choirWithOpenGuestAdmission.choirId),
      });
    expect(persistedChoirWithOpenGuestAdmission).toMatchObject({
      guestAdmissionMode: "open",
      guestSessionVersion: 1,
      joinCodeHash: null,
    });
    const choirsWithOpenGuestAdmissionResponse = await callWorker(
      "/api/guest/choirs",
    );
    expect(await choirsWithOpenGuestAdmissionResponse.json()).toEqual({
      choirs: [
        {
          id: choirWithOpenGuestAdmission.choirId,
          name: "公开合唱团",
          guestAdmissionMode: "open",
        },
      ],
    });

    const guestWithOpenAdmissionResponse = await callWorker(
      "/api/guest/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "198.51.100.4",
        },
        body: JSON.stringify({
          admission: "open",
          choirId: choirWithOpenGuestAdmission.choirId,
        }),
      },
    );
    expect(guestWithOpenAdmissionResponse.status).toBe(200);
    const guestWithOpenAdmissionCookie = cookieFrom(
      guestWithOpenAdmissionResponse,
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const repeatedOpenAdmissionResponse = await callWorker(
        "/api/guest/session",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "CF-Connecting-IP": "198.51.100.4",
          },
          body: JSON.stringify({
            admission: "open",
            choirId: choirWithOpenGuestAdmission.choirId,
          }),
        },
      );
      expect(repeatedOpenAdmissionResponse.status).toBe(200);
    }
    const scoreListWithOpenAdmissionResponse = await callWorker(
      `/api/choirs/${choirWithOpenGuestAdmission.choirId}/scores`,
      { headers: { cookie: guestWithOpenAdmissionCookie } },
    );
    expect(scoreListWithOpenAdmissionResponse.status).toBe(200);
    expect(await scoreListWithOpenAdmissionResponse.json()).toMatchObject({
      scores: [],
      permissions: { canManage: false },
    });

    const crossChoirResponse = await callWorker(
      `/api/choirs/${provisioned.choirId}/scores`,
      { headers: { cookie: guestWithOpenAdmissionCookie } },
    );
    expect(crossChoirResponse.status).toBe(403);

    const rotateJoinCodeWithOpenAdmissionResponse = await callWorker(
      `/api/choirs/${choirWithOpenGuestAdmission.choirId}/join-code/rotate`,
      { method: "POST", headers: { cookie: adminCookie } },
    );
    expect(rotateJoinCodeWithOpenAdmissionResponse.status).toBe(409);
    expect(await rotateJoinCodeWithOpenAdmissionResponse.json()).toEqual({
      error: "join_code_not_available",
    });
    const guestSessionAfterRejectedRotation = await callWorker(
      "/api/guest/session",
      { headers: { cookie: guestWithOpenAdmissionCookie } },
    );
    expect(guestSessionAfterRejectedRotation.status).toBe(200);

    const inventedInviteAdmission = await callWorker("/api/guest/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.5",
      },
      body: JSON.stringify({
        admission: "invite",
        joinCode: "CCCCCCCC",
      }),
    });
    expect(inventedInviteAdmission.status).toBe(401);

    const openAdmissionToInviteChoir = await callWorker("/api/guest/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.6",
      },
      body: JSON.stringify({
        admission: "open",
        choirId: provisioned.choirId,
      }),
    });
    expect(openAdmissionToInviteChoir.status).toBe(401);

    const joinWithOpenAdmissionResponse = await callWorker("/api/choirs/join", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: memberCookie,
        "CF-Connecting-IP": "198.51.100.7",
      },
      body: JSON.stringify({
        admission: "open",
        choirId: choirWithOpenGuestAdmission.choirId,
        displayName: "小花体验",
      }),
    });
    expect(joinWithOpenAdmissionResponse.status).toBe(201);
    expect(await joinWithOpenAdmissionResponse.json()).toMatchObject({
      membership: {
        displayName: "小花体验",
        role: "member",
        choir: {
          id: choirWithOpenGuestAdmission.choirId,
          name: "公开合唱团",
          guestAdmissionMode: "open",
        },
      },
    });

    const member = await database.query.user.findFirst({
      where: eq(user.email, memberEmail),
    });
    expect(member).toBeDefined();

    await expect(
      requireChoirRead(
        database,
        {
          kind: "guest",
          choirId: provisioned.choirId,
          guestSessionVersion: 2,
        },
        provisioned.choirId,
      ),
    ).resolves.toEqual({ kind: "guest" });
    await expect(
      requirePersonalLayerOwner(
        database,
        { kind: "user", userId: member!.id },
        provisioned.choirId,
        admin!.id,
      ),
    ).rejects.toThrow("Forbidden");
    await expect(
      requireSharedLayerEdit(
        database,
        { kind: "user", userId: member!.id },
        provisioned.choirId,
        "shared-layer-1",
      ),
    ).rejects.toThrow("Forbidden");

    const memberMembership = await database.query.memberships.findFirst({
      where: and(
        eq(memberships.choirId, provisioned.choirId),
        eq(memberships.userId, member!.id),
      ),
    });
    await database.insert(sharedLayerEditGrants).values({
      id: crypto.randomUUID(),
      choirId: provisioned.choirId,
      sharedLayerId: "shared-layer-1",
      membershipId: memberMembership!.id,
    });
    await expect(
      requireSharedLayerEdit(
        database,
        { kind: "user", userId: member!.id },
        provisioned.choirId,
        "shared-layer-1",
      ),
    ).resolves.toMatchObject({ id: memberMembership!.id });

    const loggedOutput = consoleSpies.flatMap((spy) => spy.mock.calls).join(" ");
    expect(loggedOutput).not.toContain(adminEmail);
    expect(loggedOutput).not.toContain(memberEmail);
    expect(loggedOutput).not.toContain(firstOtp.otp);
  });

  it("rate limits invite guesses without storing the raw client address", async () => {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await callWorker("/api/guest/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
        },
        body: JSON.stringify({ admission: "invite", joinCode: "AAAAAAAA" }),
      });
    }

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBeTruthy();
    const storedKey = await env.DB.prepare("SELECT key FROM rate_limits").first<{
      key: string;
    }>();
    expect(storedKey?.key).not.toContain("203.0.113.9");
  });
});

async function requestOtp(email: string) {
  const deliveredBefore = deliveredEmails.length;
  const response = await callWorker(
    "/api/auth/email-otp/send-verification-otp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, type: "sign-in" }),
    },
  );
  const responseBody = await response.text();
  expect(response.status, responseBody).toBe(200);
  expect(deliveredEmails).toHaveLength(deliveredBefore + 1);

  const delivered = deliveredEmails.at(-1)!;
  const otp = delivered.subject.match(/^([0-9]{6}) /)?.[1];
  expect(otp).toBeDefined();
  return { otp: otp!, responseBody };
}

async function signIn(email: string, otp: string) {
  const response = await callWorker("/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      otp,
      name: "Same Page 用户",
    }),
  });
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function expectOtpStoredAsHash(otp: string) {
  const verification = await env.DB.prepare(
    "SELECT value FROM verification ORDER BY created_at DESC LIMIT 1",
  ).first<{ value: string }>();
  expect(verification?.value).toBeTruthy();
  expect(verification?.value).not.toContain(otp);
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

function cookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0];
}
