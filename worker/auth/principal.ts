import { and, eq } from "drizzle-orm";
import { getSessionCookie } from "better-auth/cookies";

import { createAuth } from "./create-auth";
import { createDatabase } from "../db/database";
import { choirs } from "../db/schema";
import type { Env, WaitUntilContext } from "../env";
import {
  type GuestSession,
  verifyGuestSessionToken,
} from "../security/guest-session";

export type Principal =
  | {
      kind: "user";
      userId: string;
    }
  | {
      kind: "guest";
      choirId: string;
      guestSessionVersion: number;
    };

export async function resolvePrincipal(options: {
  request: Request;
  env: Env;
  executionContext: WaitUntilContext;
  guestToken?: string;
}): Promise<Principal | null> {
  const candidates = await resolvePrincipalCandidates(options);
  if (candidates.user) return candidates.user;
  return resolveGuestPrincipalFromClaims({
    env: options.env,
    claims: candidates.guest,
  });
}

export async function resolvePrincipalCandidates(options: {
  request: Request;
  env: Env;
  executionContext: WaitUntilContext;
  guestToken?: string;
  loadAuthSession?: () => Promise<{ user: { id: string } } | null>;
}) {
  const authentication = getSessionCookie(options.request.headers)
    ? options.loadAuthSession?.() ??
      createAuth(options.env, options.executionContext).api.getSession({
        headers: options.request.headers,
      })
    : Promise.resolve(null);
  const guest = options.guestToken
    ? verifyGuestSessionToken(options.guestToken, options.env.INVITE_SECRET)
    : Promise.resolve(null);
  const [session, guestClaims] = await Promise.all([authentication, guest]);
  return {
    user: session?.user.id
      ? { kind: "user" as const, userId: session.user.id }
      : null,
    guest: guestClaims,
  };
}

export async function resolveGuestPrincipal(options: {
  env: Env;
  guestToken?: string;
}): Promise<Extract<Principal, { kind: "guest" }> | null> {
  if (!options.guestToken) {
    return null;
  }

  const claims = await verifyGuestSessionToken(
    options.guestToken,
    options.env.INVITE_SECRET,
  );
  return resolveGuestPrincipalFromClaims({ env: options.env, claims });
}

async function resolveGuestPrincipalFromClaims(options: {
  env: Env;
  claims: GuestSession | null;
}): Promise<Extract<Principal, { kind: "guest" }> | null> {
  if (!options.claims) return null;
  const database = createDatabase(options.env.DB);
  const choir = await database.query.choirs.findFirst({
    where: and(
      eq(choirs.id, options.claims.choirId),
      eq(choirs.guestSessionVersion, options.claims.guestSessionVersion),
    ),
    columns: { id: true },
  });

  if (!choir) {
    return null;
  }

  return {
    kind: "guest",
    choirId: options.claims.choirId,
    guestSessionVersion: options.claims.guestSessionVersion,
  };
}
