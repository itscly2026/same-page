import { setupNetwork } from "@msw/cloudflare";
import { hashPassword } from "better-auth/crypto";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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
import { hashRateLimitIdentity } from "./security/rate-limit";
import {
  cookieFrom,
  registerWithPassword,
  signInWithPassword,
} from "./test/auth";

const network = setupNetwork();
const deliveredEmails: Array<{
  from: string;
  html: string;
  subject: string;
  to: string;
  text: string;
}> = [];
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
let googlePrivateKey: Awaited<
  ReturnType<typeof generateKeyPair>
>["privateKey"];
let googlePublicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  network.enable();
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  googlePrivateKey = keyPair.privateKey;
  googlePublicJwk = await exportJWK(keyPair.publicKey);
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
  it("exposes configured providers and starts minimal Google and Website App WeChat flows", async () => {
    const providers = await callWorker("/api/auth/social-providers");
    expect(providers.status).toBe(200);
    expect(providers.headers.get("Cache-Control")).toBe("no-store");
    expect(await providers.json()).toEqual({
      providers: ["google", "wechat"],
    });

    const google = await startSocialAuthentication("google");
    const googleUrl = new URL(google.url);
    expect(google.redirect).toBe(true);
    expect(googleUrl.origin).toBe("https://accounts.google.com");
    expect(googleUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(googleUrl.searchParams.get("redirect_uri")).toBe(
      "https://same-page.test/api/auth/callback/google",
    );
    expect(new Set(googleUrl.searchParams.get("scope")?.split(" "))).toEqual(
      new Set(["email", "profile", "openid"]),
    );

    const wechat = await startSocialAuthentication("wechat");
    const wechatUrl = new URL(wechat.url);
    expect(wechat.redirect).toBe(true);
    expect(wechatUrl.origin).toBe("https://open.weixin.qq.com");
    expect(wechatUrl.pathname).toBe("/connect/qrconnect");
    expect(wechatUrl.searchParams.get("redirect_uri")).toBe(
      "https://same-page.test/api/auth/callback/wechat",
    );
    expect(wechatUrl.searchParams.get("scope")).toBe("snsapi_login");
    expect(wechatUrl.searchParams.get("lang")).toBe("cn");
    expect(wechatUrl.hash).toBe("#wechat_redirect");
  });

  it("returns provider cancellation and invalid OAuth state to the recoverable login route", async () => {
    const start = await callWorker("/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://same-page.test",
      },
      body: JSON.stringify({
        provider: "wechat",
        callbackURL: "/login?oauth=complete",
        errorCallbackURL: "/login?oauth=error",
      }),
    });
    const startBody = (await start.json()) as { url: string };
    const state = new URL(startBody.url).searchParams.get("state");

    const cancelled = await callWorker(
      `/api/auth/callback/wechat?error=access_denied&state=${encodeURIComponent(state!)}`,
      {
        headers: { cookie: cookieFrom(start) },
        redirect: "manual",
      },
    );
    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get("location")).toBe(
      "/login?oauth=error&error=access_denied",
    );

    const repeated = await callWorker(
      `/api/auth/callback/wechat?error=access_denied&state=${encodeURIComponent(state!)}`,
      {
        headers: { cookie: cookieFrom(start) },
        redirect: "manual",
      },
    );
    expect(repeated.status).toBe(302);
    expect(repeated.headers.get("location")).toBe(
      "/login?oauth=error&error=state_mismatch",
    );

    const invalidState = await callWorker(
      "/api/auth/callback/wechat?code=wechat-code&state=invalid-state",
      { redirect: "manual" },
    );
    expect(invalidState.status).toBe(302);
    expect(invalidState.headers.get("location")).toBe(
      "/login?oauth=error&error=state_mismatch",
    );
  });

  it("returns WeChat token and profile network failures to the internal login route", async () => {
    const failures = [
      {
        configure() {
          network.use(
            http.get(
              "https://api.weixin.qq.com/sns/oauth2/access_token",
              () => HttpResponse.json({ error: "unavailable" }, { status: 503 }),
            ),
          );
        },
      },
      {
        configure() {
          network.use(
            http.get(
              "https://api.weixin.qq.com/sns/oauth2/access_token",
              () =>
                HttpResponse.json({
                  access_token: "wechat-access-token",
                  expires_in: 7200,
                  refresh_token: "wechat-refresh-token",
                  openid: "wechat-openid",
                  scope: "snsapi_login",
                }),
            ),
            http.get("https://api.weixin.qq.com/sns/userinfo", () =>
              HttpResponse.json({ error: "unavailable" }, { status: 503 }),
            ),
          );
        },
      },
    ];

    for (const failure of failures) {
      failure.configure();
      const start = await callWorker("/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://same-page.test",
        },
        body: JSON.stringify({
          provider: "wechat",
          callbackURL: "/login?oauth=complete",
          errorCallbackURL: "/login?oauth=error",
        }),
      });
      const startBody = (await start.json()) as { url: string };
      const state = new URL(startBody.url).searchParams.get("state");
      const callback = await callWorker(
        `/api/auth/callback/wechat?code=wechat-code&state=${encodeURIComponent(state!)}`,
        {
          headers: { cookie: cookieFrom(start) },
          redirect: "manual",
        },
      );

      expect(callback.status).toBe(302);
      const location = new URL(
        callback.headers.get("location")!,
        "https://same-page.test",
      );
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("oauth")).toBe("error");
      expect(location.searchParams.get("error")).toBeTruthy();
      expect(location.href).not.toContain("wechat-code");
      expect(location.href).not.toContain("wechat-access-token");
    }

    const database = createDatabase(env.DB);
    expect(await database.select().from(user)).toHaveLength(0);
    expect(await database.select().from(account)).toHaveLength(0);
  });

  it("rejects an OAuth continuation outside the trusted Same Page origin", async () => {
    const response = await callWorker("/api/auth/sign-in/social", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://same-page.test",
      },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "https://attacker.example/after-auth",
        errorCallbackURL: "/login?oauth=error",
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("attacker.example");
  });

  it("does not expose manual account management or provider token endpoints", async () => {
    const registration = await registerWithPassword({
      callWorker,
      email: "account-boundary@example.test",
      latestOtp,
    });
    const requests: Array<[string, RequestInit]> = [
      ["/api/auth/account-info", { method: "GET" }],
      ["/api/auth/get-access-token", { method: "POST" }],
      ["/api/auth/link-social", { method: "POST" }],
      ["/api/auth/list-accounts", { method: "GET" }],
      ["/api/auth/refresh-token", { method: "POST" }],
      ["/api/auth/unlink-account", { method: "POST" }],
    ];

    for (const [path, init] of requests) {
      const response = await callWorker(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          cookie: registration.cookie,
        },
        ...(init.method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, path).toBe(404);
    }
  });

  it("creates one WeChat user from unionid with non-routable email and encrypted tokens", async () => {
    const firstSessionCookie = await completeWechatAuthentication();
    expect(firstSessionCookie).toContain("better-auth.session_token=");

    const database = createDatabase(env.DB);
    const createdUsers = await database.select().from(user);
    expect(createdUsers).toHaveLength(1);
    expect(createdUsers[0]).toMatchObject({
      name: "微信成员",
      email: "wechat-unionid@wechat.placeholder.invalid",
      emailVerified: false,
    });

    const createdAccounts = await database.select().from(account);
    expect(createdAccounts).toHaveLength(1);
    expect(createdAccounts[0]).toMatchObject({
      accountId: "wechat-unionid",
      providerId: "wechat",
      userId: createdUsers[0].id,
      scope: "snsapi_login",
    });
    expect(createdAccounts[0].accessToken).not.toBe("wechat-access-token");
    expect(createdAccounts[0].refreshToken).not.toBe("wechat-refresh-token");
    expect(deliveredEmails).toHaveLength(0);

    const emailFlow = await callWorker("/api/auth/flow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: createdUsers[0].email }),
    });
    expect(emailFlow.status).toBe(400);
    const passwordReset = await callWorker(
      "/api/auth/email-otp/request-password-reset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: createdUsers[0].email }),
      },
    );
    expect(passwordReset.status).toBe(400);
    expect(deliveredEmails).toHaveLength(0);

    await completeWechatAuthentication();
    expect(await database.select().from(user)).toHaveLength(1);
    expect(await database.select().from(account)).toHaveLength(1);
  });

  it("falls back to the Website App openid when WeChat omits unionid", async () => {
    await completeWechatAuthentication({
      openid: "wechat-openid-only",
      unionid: undefined,
    });

    const database = createDatabase(env.DB);
    expect(await database.select().from(user)).toContainEqual(
      expect.objectContaining({
        email: "wechat-openid-only@wechat.placeholder.invalid",
      }),
    );
    expect(await database.select().from(account)).toContainEqual(
      expect.objectContaining({
        accountId: "wechat-openid-only",
        providerId: "wechat",
      }),
    );
  });

  it("links Google only to an existing verified email and creates a user for a different email", async () => {
    const database = createDatabase(env.DB);
    const existingUserId = crypto.randomUUID();
    await database.insert(user).values({
      id: existingUserId,
      name: "邮箱成员",
      email: "verified@example.test",
      emailVerified: true,
    });

    const googleIdToken = await completeGoogleAuthentication({
      subject: "google-existing-subject",
      email: "verified@example.test",
      name: "Google 昵称",
    });
    let users = await database.select().from(user);
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe(existingUserId);
    expect(users[0].name).toBe("邮箱成员");
    const googleAccounts = await database.select().from(account);
    expect(googleAccounts).toContainEqual(
      expect.objectContaining({
        accountId: "google-existing-subject",
        idToken: null,
        providerId: "google",
        userId: existingUserId,
      }),
    );
    expect(googleAccounts[0].idToken).not.toBe(googleIdToken);
    expect(googleAccounts[0].accessToken).not.toBe("google-access-token");
    expect(googleAccounts[0].refreshToken).not.toBe("google-refresh-token");

    await completeGoogleAuthentication({
      subject: "google-existing-subject",
      email: "verified@example.test",
      name: "Google 新昵称",
    });
    expect(await database.select().from(user)).toHaveLength(1);
    expect(await database.select().from(account)).toHaveLength(1);

    await completeGoogleAuthentication({
      subject: "google-new-subject",
      email: "different@example.test",
      name: "另一位成员",
    });
    users = await database.select().from(user);
    expect(users).toHaveLength(2);
    expect(users).toContainEqual(
      expect.objectContaining({
        email: "different@example.test",
        emailVerified: true,
        name: "另一位成员",
      }),
    );
  });

  it("allows exactly one open-admission preview entry", async () => {
    const adminUserId = crypto.randomUUID();
    await createDatabase(env.DB).insert(user).values({
      id: adminUserId,
      name: "Preview admin",
      email: "preview-admin@example.test",
      emailVerified: true,
    });

    await expect(
      provisionChoir({
        binding: env.DB,
        adminUserId,
        adminDisplayName: "管理员",
        guestAdmissionMode: "invite",
        isPreviewEntry: true,
        inviteSecret: env.INVITE_SECRET,
      }),
    ).rejects.toThrow("Preview entry choir must use open guest admission");

    await provisionChoir({
      binding: env.DB,
      adminUserId,
      adminDisplayName: "管理员",
      choirName: "公开体验云盘",
      guestAdmissionMode: "open",
      isPreviewEntry: true,
      inviteSecret: env.INVITE_SECRET,
    });
    await expect(
      provisionChoir({
        binding: env.DB,
        adminUserId,
        adminDisplayName: "管理员",
        choirName: "另一个体验入口",
        guestAdmissionMode: "open",
        isPreviewEntry: true,
        inviteSecret: env.INVITE_SECRET,
      }),
    ).rejects.toThrow();
  });

  it("routes normalized emails with bounded account discovery", async () => {
    const database = createDatabase(env.DB);
    await database.insert(user).values({
      id: crypto.randomUUID(),
      name: "Existing user",
      email: "existing@example.test",
      emailVerified: true,
    });

    const existing = await callWorker("/api/auth/flow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.20",
      },
      body: JSON.stringify({ email: " Existing@Example.Test " }),
    });
    expect(await existing.json()).toEqual({ flow: "sign-in" });

    const newcomer = await callWorker("/api/auth/flow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.20",
      },
      body: JSON.stringify({ email: "new@example.test" }),
    });
    expect(await newcomer.json()).toEqual({ flow: "sign-up" });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const allowed = await callWorker("/api/auth/flow", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": `198.51.100.${30 + attempt}`,
        },
        body: JSON.stringify({ email: "bounded@example.test" }),
      });
      expect(allowed.status).toBe(200);
    }
    const emailLimited = await callWorker("/api/auth/flow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.50",
      },
      body: JSON.stringify({ email: "bounded@example.test" }),
    });
    expect(emailLimited.status).toBe(429);
    expect(emailLimited.headers.get("Retry-After")).toBeTruthy();
    expect(await emailLimited.json()).toEqual({ error: "try_again_later" });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const allowed = await callWorker("/api/auth/flow", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "198.51.100.60",
        },
        body: JSON.stringify({ email: `person-${attempt}@example.test` }),
      });
      expect(allowed.status).toBe(200);
    }
    const ipLimited = await callWorker("/api/auth/flow", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "198.51.100.60",
      },
      body: JSON.stringify({ email: "one-more@example.test" }),
    });
    expect(ipLimited.status).toBe(429);
  });

  it("runs verified registration, password login, guest access, rotation and member authorization", async () => {
    const adminEmail = "admin@example.test";
    const adminRegistration = await registerWithPassword({
      callWorker,
      email: adminEmail,
      latestOtp,
      afterOtpSent: expectOtpStoredAsHash,
    });
    const deliveredAfterRegistration = deliveredEmails.length;
    expect(deliveredEmails.at(-1)).toMatchObject({
      from: "Same Page <login@example.test>",
      subject: "Same Page 注册验证码",
    });
    expect(deliveredEmails.at(-1)?.subject).not.toMatch(/\d{6}/);
    expect(deliveredEmails.at(-1)?.text).toContain("samepage.clyapps.com");
    expect(deliveredEmails.at(-1)?.text).toContain("10 分钟");
    expect(deliveredEmails.at(-1)?.html).toContain("samepage.clyapps.com");
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
    expect(verifiedEmailOtp.status).toBe(429);
    expect(verifiedEmailOtp.headers.get("Retry-After")).toBeTruthy();
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
        name: "小红花云盘",
        guestAdmissionMode: "invite",
      },
      entryKind: "admission",
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
    const joinStateBeforeDisplayName = await callWorker(
      "/api/choirs/current-guest/join-state",
      {
        headers: { cookie: `${memberCookie}; ${currentGuestCookie}` },
      },
    );
    expect(await joinStateBeforeDisplayName.json()).toMatchObject({
      status: "display-name-required",
      choir: { id: provisioned.choirId },
    });
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
          choir: { id: provisioned.choirId, name: "小红花云盘" },
        },
      ],
    });

    const secondChoir = await provisionChoir({
      binding: env.DB,
      adminUserId: admin!.id,
      adminDisplayName: "管理员",
      choirName: "第二云盘",
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
      choirName: "公开体验云盘",
      guestAdmissionMode: "open",
      isPreviewEntry: true,
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
      isPreviewEntry: true,
      joinCodeHash: null,
    });
    const previewChoirResponse = await callWorker("/api/guest/preview-choir");
    expect(await previewChoirResponse.json()).toEqual({
      choir: {
        id: choirWithOpenGuestAdmission.choirId,
        name: "公开体验云盘",
        guestAdmissionMode: "open",
      },
    });
    const adminDriveListResponse = await callWorker("/api/choirs", {
      headers: { cookie: adminCookie },
    });
    const adminDriveList = (await adminDriveListResponse.json()) as {
      memberships: Array<{ choir: { id: string } }>;
    };
    expect(adminDriveList.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          choir: expect.objectContaining({ id: provisioned.choirId }),
        }),
        expect.objectContaining({
          choir: expect.objectContaining({ id: secondChoir.choirId }),
        }),
      ]),
    );
    expect(adminDriveList.memberships).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          choir: expect.objectContaining({
            id: choirWithOpenGuestAdmission.choirId,
          }),
        }),
      ]),
    );
    const openChoirDetailResponse = await callWorker(
      `/api/guest/choirs/${choirWithOpenGuestAdmission.choirId}`,
    );
    expect(await openChoirDetailResponse.json()).toEqual({
      choir: {
        id: choirWithOpenGuestAdmission.choirId,
        name: "公开体验云盘",
        guestAdmissionMode: "open",
      },
      entryKind: "preview",
    });
    const inviteChoirDetailResponse = await callWorker(
      `/api/guest/choirs/${provisioned.choirId}`,
    );
    expect(inviteChoirDetailResponse.status).toBe(404);

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
    const signedInPreviewResponse = await callWorker(
      `/api/choirs/${choirWithOpenGuestAdmission.choirId}/scores`,
      { headers: { cookie: `${memberCookie}; ${guestWithOpenAdmissionCookie}` } },
    );
    expect(signedInPreviewResponse.status).toBe(200);
    expect(await signedInPreviewResponse.json()).toMatchObject({
      permissions: { canManage: false },
    });
    const previewAdminResponse = await callWorker(
      `/api/choirs/${choirWithOpenGuestAdmission.choirId}/scores`,
      { headers: { cookie: `${adminCookie}; ${guestWithOpenAdmissionCookie}` } },
    );
    expect(await previewAdminResponse.json()).toMatchObject({
      permissions: { canManage: true },
    });
    const signedInPreviewUpload = await callWorker(
      `/api/choirs/${choirWithOpenGuestAdmission.choirId}/scores`,
      {
        method: "POST",
        headers: { cookie: `${memberCookie}; ${guestWithOpenAdmissionCookie}` },
      },
    );
    expect(signedInPreviewUpload.status).toBe(403);

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
    expect(await guestSessionAfterRejectedRotation.json()).toMatchObject({
      entryKind: "preview",
    });
    const previewJoinState = await callWorker(
      "/api/choirs/current-guest/join-state",
      {
        headers: {
          cookie: `${memberCookie}; ${guestWithOpenAdmissionCookie}`,
        },
      },
    );
    expect(previewJoinState.status).toBe(403);
    expect(await previewJoinState.json()).toEqual({
      error: "preview_membership_not_available",
    });
    const previewJoinCurrentGuest = await callWorker(
      "/api/choirs/join-current-guest",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${memberCookie}; ${guestWithOpenAdmissionCookie}`,
        },
        body: JSON.stringify({ displayName: "不应加入" }),
      },
    );
    expect(previewJoinCurrentGuest.status).toBe(403);

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
    expect(joinWithOpenAdmissionResponse.status).toBe(403);
    expect(await joinWithOpenAdmissionResponse.json()).toEqual({
      error: "preview_membership_not_available",
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
        "E",
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
      slot: "E",
      membershipId: memberMembership!.id,
    });
    await expect(
      requireSharedLayerEdit(
        database,
        { kind: "user", userId: member!.id },
        provisioned.choirId,
        "E",
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
    expect(deliveredEmails.at(-1)?.subject).toBe(
      "Same Page 密码重设验证码",
    );
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
    await expireOtpCooldown(email);

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

  it("enforces OTP cooldown and mailbox windows without storing raw identities", async () => {
    const email = "rate-limited@example.test";
    const client = "203.0.113.41";

    const first = await requestRegistrationOtp(email, client);
    expect(first.status).toBe(200);
    expect(deliveredEmails).toHaveLength(1);

    const duplicate = await requestRegistrationOtp(email, client);
    expect(duplicate.status).toBe(429);
    expect(Number(duplicate.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(deliveredEmails).toHaveLength(1);

    await expireOtpCooldown(email);
    expect((await requestRegistrationOtp(email, client)).status).toBe(200);
    await expireOtpCooldown(email);
    expect((await requestRegistrationOtp(email, client)).status).toBe(200);
    expect(deliveredEmails).toHaveLength(3);

    await expireOtpCooldown(email);
    const emailLimited = await requestRegistrationOtp(email, "203.0.113.99");
    expect(emailLimited.status).toBe(429);
    expect(Number(emailLimited.headers.get("Retry-After"))).toBeGreaterThan(
      60,
    );
    expect(deliveredEmails).toHaveLength(3);

    const storedKeys = await env.DB.prepare(
      "SELECT key FROM rate_limits ORDER BY key",
    ).all<{ key: string }>();
    const serializedKeys = JSON.stringify(storedKeys.results);
    expect(serializedKeys).not.toContain(email);
    expect(serializedKeys).not.toContain(client);
  });

  it("limits one client across independent mailboxes", async () => {
    const client = "203.0.113.42";
    for (let index = 0; index < 10; index += 1) {
      const response = await requestRegistrationOtp(
        `client-window-${index}@example.test`,
        client,
      );
      expect(response.status, `request ${index + 1}`).toBe(200);
    }
    expect(deliveredEmails).toHaveLength(10);

    const limited = await requestRegistrationOtp(
      "client-window-overflow@example.test",
      client,
    );
    expect(limited.status).toBe(429);
    expect(deliveredEmails).toHaveLength(10);

    const independent = await requestRegistrationOtp(
      "independent-client@example.test",
      "203.0.113.43",
    );
    expect(independent.status).toBe(200);
    expect(deliveredEmails).toHaveLength(11);
  });

  it("applies the same cooldown to password-reset delivery", async () => {
    const email = "reset-cooldown@example.test";
    const database = createDatabase(env.DB);
    await database.insert(user).values({
      id: crypto.randomUUID(),
      name: "重设密码用户",
      email,
      emailVerified: true,
    });

    const first = await callWorker(
      "/api/auth/email-otp/request-password-reset",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.44",
        },
        body: JSON.stringify({ email }),
      },
    );
    expect(first.status).toBe(200);
    expect(deliveredEmails).toHaveLength(1);

    const duplicate = await callWorker(
      "/api/auth/email-otp/request-password-reset",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.45",
        },
        body: JSON.stringify({ email }),
      },
    );
    expect(duplicate.status).toBe(429);
    expect(duplicate.headers.get("Retry-After")).toBeTruthy();
    expect(deliveredEmails).toHaveLength(1);
  });

  it("invalidates the previous registration OTP when a new one is sent", async () => {
    const email = "latest-otp@example.test";
    expect((await requestRegistrationOtp(email)).status).toBe(200);
    const previousOtp = latestOtp();

    let currentOtp = previousOtp;
    for (
      let attempt = 0;
      attempt < 2 && currentOtp === previousOtp;
      attempt += 1
    ) {
      await expireOtpCooldown(email);
      expect((await requestRegistrationOtp(email)).status).toBe(200);
      currentOtp = latestOtp();
    }
    expect(currentOtp).not.toBe(previousOtp);

    const stale = await completeRegistrationWithOtp(email, previousOtp);
    expect(stale.status).toBe(400);
    const current = await completeRegistrationWithOtp(email, currentOtp);
    expect(current.status).toBe(200);
  });
});

function latestOtp() {
  const otp = deliveredEmails.at(-1)?.text.match(/验证码：([0-9]{6})/)?.[1];
  expect(otp).toBeDefined();
  return otp!;
}

async function requestRegistrationOtp(
  email: string,
  client = "203.0.113.40",
) {
  return callWorker("/api/auth/registration/request-otp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": client,
    },
    body: JSON.stringify({ email }),
  });
}

async function completeRegistrationWithOtp(email: string, otp: string) {
  return callWorker("/api/auth/registration/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      otp,
      password: "correct horse battery staple",
    }),
  });
}

async function expireOtpCooldown(email: string) {
  const key = await hashRateLimitIdentity(
    `auth-otp:email-cooldown:${email.trim().toLowerCase()}`,
    env.INVITE_SECRET,
  );
  await env.DB.prepare(
    "UPDATE rate_limits SET window_expires_at = 0 WHERE key = ?",
  )
    .bind(key)
    .run();
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

async function startSocialAuthentication(provider: "google" | "wechat") {
  const response = await callWorker("/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://same-page.test",
    },
    body: JSON.stringify({
      provider,
      callbackURL: "/login?oauth=complete",
      errorCallbackURL: "/login?oauth=error",
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { redirect: boolean; url: string };
}

async function completeWechatAuthentication(
  identity: { openid: string; unionid?: string } = {
    openid: "wechat-openid",
    unionid: "wechat-unionid",
  },
) {
  network.use(
    http.get(
      "https://api.weixin.qq.com/sns/oauth2/access_token",
      () =>
        HttpResponse.json({
          access_token: "wechat-access-token",
          expires_in: 7200,
          refresh_token: "wechat-refresh-token",
          openid: identity.openid,
          scope: "snsapi_login",
          ...(identity.unionid ? { unionid: identity.unionid } : {}),
        }),
    ),
    http.get("https://api.weixin.qq.com/sns/userinfo", () =>
      HttpResponse.json({
        openid: identity.openid,
        nickname: "微信成员",
        headimgurl: "https://example.test/wechat-avatar.png",
        privilege: [],
        ...(identity.unionid ? { unionid: identity.unionid } : {}),
      }),
    ),
  );

  const start = await callWorker("/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://same-page.test",
    },
    body: JSON.stringify({
      provider: "wechat",
      callbackURL: "/login?oauth=complete",
      errorCallbackURL: "/login?oauth=error",
    }),
  });
  expect(start.status, await start.clone().text()).toBe(200);
  const startBody = (await start.json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await callWorker(
    `/api/auth/callback/wechat?code=wechat-code&state=${encodeURIComponent(state!)}`,
    {
      headers: { cookie: cookieFrom(start) },
      redirect: "manual",
    },
  );
  expect(callback.status, await callback.clone().text()).toBe(302);
  expect(callback.headers.get("location")).toBe("/login?oauth=complete");
  const sessionCookie = callback.headers
    .get("set-cookie")
    ?.match(/(?:^|,\s*)((?:__Secure-)?better-auth\.session_token=[^;]+)/)?.[1];
  expect(sessionCookie).toBeTruthy();
  return sessionCookie!;
}

async function completeGoogleAuthentication(profile: {
  subject: string;
  email: string;
  name: string;
}) {
  const idToken = await new SignJWT({
    sub: profile.subject,
    email: profile.email,
    email_verified: true,
    name: profile.name,
    picture: "https://example.test/google-avatar.png",
  })
    .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience("test-google-client-id")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(googlePrivateKey);

  network.use(
    http.post("https://oauth2.googleapis.com/token", () =>
      HttpResponse.json({
        access_token: "google-access-token",
        expires_in: 3600,
        id_token: idToken,
        refresh_token: "google-refresh-token",
        scope: "openid email profile",
        token_type: "Bearer",
      }),
    ),
    http.get("https://www.googleapis.com/oauth2/v3/certs", () =>
      HttpResponse.json({
        keys: [
          {
            ...googlePublicJwk,
            alg: "RS256",
            kid: "google-test-key",
            use: "sig",
          },
        ],
      }),
    ),
  );

  const start = await callWorker("/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://same-page.test",
    },
    body: JSON.stringify({
      provider: "google",
      callbackURL: "/login?oauth=complete",
      errorCallbackURL: "/login?oauth=error",
    }),
  });
  expect(start.status, await start.clone().text()).toBe(200);
  const startBody = (await start.json()) as { url: string };
  const state = new URL(startBody.url).searchParams.get("state");
  expect(state).toBeTruthy();

  const callback = await callWorker(
    `/api/auth/callback/google?code=google-code&state=${encodeURIComponent(state!)}`,
    {
      headers: { cookie: cookieFrom(start) },
      redirect: "manual",
    },
  );
  expect(callback.status, await callback.clone().text()).toBe(302);
  expect(callback.headers.get("location")).toBe("/login?oauth=complete");
  return idToken;
}
