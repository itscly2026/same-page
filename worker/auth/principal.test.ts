import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env, WaitUntilContext } from "../env";
import { createGuestSessionToken } from "../security/guest-session";
import { resolvePrincipalCandidates } from "./principal";

const env: Env = { ...testEnv, INVITE_SECRET: "test-invite-secret" };
const executionContext = { waitUntil: vi.fn() } as unknown as WaitUntilContext;

describe("principal candidates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not initialize Better Auth when no auth session cookie exists", async () => {
    const loadAuthSession = vi.fn();
    const guestToken = await createGuestSessionToken({
      choirId: "drive",
      guestSessionVersion: 3,
      expiresAt: Date.now() + 60_000,
    }, env.INVITE_SECRET);

    const candidates = await resolvePrincipalCandidates({
      request: new Request("https://samepage.test/api/choirs/drive/bootstrap"),
      env,
      executionContext,
      guestToken,
      loadAuthSession,
    });

    expect(loadAuthSession).not.toHaveBeenCalled();
    expect(candidates).toEqual({
      user: null,
      guest: {
        choirId: "drive",
        guestSessionVersion: 3,
        expiresAt: expect.any(Number),
      },
    });
  });

  it("resolves an authenticated user when the Better Auth cookie exists", async () => {
    const loadAuthSession = vi.fn().mockResolvedValue({ user: { id: "user-1" } });
    const request = new Request("https://samepage.test/api/choirs/drive/bootstrap", {
      headers: { cookie: "better-auth.session_token=session-value" },
    });

    const candidates = await resolvePrincipalCandidates({
      request,
      env,
      executionContext,
      loadAuthSession,
    });

    expect(loadAuthSession).toHaveBeenCalledTimes(1);
    expect(candidates).toEqual({
      user: { kind: "user", userId: "user-1" },
      guest: null,
    });
  });
});
