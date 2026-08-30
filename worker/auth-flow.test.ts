import { setupNetwork } from "@msw/cloudflare";
import { hashPassword } from "better-auth/crypto";
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
  account,
  choirs,
  memberships,
  sharedLayerEditGrants,
  user,
} from "./db/schema";
import {
  cookieFrom,
  registerWithPassword,
  signInWithPassword,
} from "./test/auth";

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
  it("runs verified registration, password login, guest access, rotation and member authorization", async () => {
    const adminEmail = "admin@example.test";
    const adminRegistration = await registerWithPassword({
      callWorker,
      email: adminEmail,
      latestOtp,
      afterOtpSent: expectOtpStoredAsHash,
    });
    const deliveredAfterRegistration = deliveredEmails.length;
    expect(deliveredEmails.at(-1)?.subject).toContain("完成 Same Page 注册");
    const passwordLogin = await signInWithPassword({
      callWorker,
      email: adminEmail,
    });
    expect(passwordLogin.status).toBe(200);
    expect(deliveredEmails).toHaveLength(deliveredAfterRegistration);
    const adminCookie = cookieFrom(passwordLogin);

    const otpSignIn = await callWorker("/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: adminEmail, otp: "123456" }),
    });
    expect(otpSignIn.status).toBe(404);
    const otpSignInWithTrailingSlash = await callWorker(
      "/api/auth/sign-in/email-otp/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: adminEmail, otp: "123456" }),
      },
    );
    expect(otpSignInWithTrailingSlash.status).toBe(404);
    const otpSignInDelivery = await callWorker(
      "/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: adminEmail, type: "sign-in" }),
      },
    );
    expect(otpSignInDelivery.status).toBe(404);
    expect(deliveredEmails).toHaveLength(deliveredAfterRegistration);

    const duplicateRegistration = await callWorker(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: adminEmail,
          password: "another secure password",
          name: "Same Page 用户",
        }),
      },
    );
    expect(duplicateRegistration.status).toBe(404);
    const verifiedEmailOtp = await callWorker(
      "/api/auth/registration/request-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: adminEmail }),
      },
    );
    expect(verifiedEmailOtp.status).toBe(200);
    expect(deliveredEmails).toHaveLength(deliveredAfterRegistration);

    const unknownEmailReset = await callWorker(
      "/api/auth/email-otp/request-password-reset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unknown@example.test" }),
      },
    );
    expect(unknownEmailReset.status).toBe(200);
    expect(deliveredEmails).toHaveLength(deliveredAfterRegistration);

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
    const memberRegistration = await registerWithPassword({
      callWorker,
      email: memberEmail,
      latestOtp,
    });
    const memberCookie = memberRegistration.cookie;
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
    expect(loggedOutput).not.toContain(adminRegistration.otp);
  });

  it("sets the first password for a verified account without a credential", async () => {
    const database = createDatabase(env.DB);
    const email = "existing-admin@example.test";
    const userId = crypto.randomUUID();
    await database.insert(user).values({
      id: userId,
      name: "管理员",
      email,
      emailVerified: true,
    });

    const requestReset = await callWorker(
      "/api/auth/email-otp/request-password-reset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
    );
    expect(requestReset.status).toBe(200);
    const otp = latestOtp();
    expect(deliveredEmails.at(-1)?.subject).toContain("重设 Same Page 密码");
    await expectOtpStoredAsHash(otp);

    const newPassword = "new secure administrator password";
    const reset = await callWorker("/api/auth/email-otp/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, otp, password: newPassword }),
    });
    expect(reset.status).toBe(200);

    const credential = await database.query.account.findFirst({
      where: eq(account.userId, userId),
      columns: { password: true, providerId: true },
    });
    expect(credential).toMatchObject({ providerId: "credential" });
    expect(credential?.password).toBeTruthy();
    expect(credential?.password).not.toBe(newPassword);

    const signIn = await signInWithPassword({
      callWorker,
      email,
      password: newPassword,
    });
    expect(signIn.status).toBe(200);
  });

  it("replaces every unverified pre-existing credential with the mailbox owner's password", async () => {
    const database = createDatabase(env.DB);
    const email = "pre-registered@example.test";
    const userId = crypto.randomUUID();
    const attackerPassword = "attacker chosen password";
    await database.insert(user).values({
      id: userId,
      name: "Unverified user",
      email,
      emailVerified: false,
    });
    await database.insert(account).values({
      id: crypto.randomUUID(),
      issuer: "credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(attackerPassword),
    });

    const ownerPassword = "mailbox owner password";
    const registration = await registerWithPassword({
      callWorker,
      email,
      latestOtp,
      password: ownerPassword,
    });
    expect(registration.cookie).toContain("better-auth.session_token=");

    const credentials = await database.query.account.findMany({
      where: eq(account.userId, userId),
    });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ providerId: "credential" });

    const attackerSignIn = await signInWithPassword({
      callWorker,
      email,
      password: attackerPassword,
    });
    expect(attackerSignIn.status).toBe(401);
    const ownerSignIn = await signInWithPassword({
      callWorker,
      email,
      password: ownerPassword,
    });
    expect(ownerSignIn.status).toBe(200);
  });

  it("revokes existing sessions and the old password after a password reset", async () => {
    const email = "password-reset@example.test";
    const registration = await registerWithPassword({
      callWorker,
      email,
      latestOtp,
    });

    const requestReset = await callWorker(
      "/api/auth/email-otp/request-password-reset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
    );
    expect(requestReset.status).toBe(200);

    const newPassword = "a different secure password";
    const reset = await callWorker("/api/auth/email-otp/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, otp: latestOtp(), password: newPassword }),
    });
    expect(reset.status).toBe(200);

    const oldSession = await callWorker("/api/auth/get-session", {
      headers: { cookie: registration.cookie },
    });
    expect(oldSession.status).toBe(200);
    expect(await oldSession.json()).toBeNull();

    const oldPassword = await signInWithPassword({ callWorker, email });
    expect(oldPassword.status).toBe(401);
    const newPasswordSignIn = await signInWithPassword({
      callWorker,
      email,
      password: newPassword,
    });
    expect(newPasswordSignIn.status).toBe(200);
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

function latestOtp() {
  const otp = deliveredEmails.at(-1)?.subject.match(/^([0-9]{6}) /)?.[1];
  expect(otp).toBeDefined();
  return otp!;
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
