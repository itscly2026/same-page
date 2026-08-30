import { and, eq } from "drizzle-orm";

import { createAuth } from "./create-auth";
import { createDatabase } from "../db/database";
import { choirs } from "../db/schema";
import type { Env, WaitUntilContext } from "../env";
import { verifyGuestSessionToken } from "../security/guest-session";

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
  const auth = createAuth(options.env, options.executionContext);
  const session = await auth.api.getSession({ headers: options.request.headers });

  if (session?.user.id) {
    return { kind: "user", userId: session.user.id };
  }

  return resolveGuestPrincipal({
    env: options.env,
    guestToken: options.guestToken,
  });
}

export async function resolveGuestPrincipal(options: {
  env: Env;
  guestToken?: string;
}): Promise<Extract<Principal, { kind: "guest" }> | null> {
  if (!options.guestToken) {
    return null;
  }

  const guestSession = await verifyGuestSessionToken(
    options.guestToken,
    options.env.INVITE_SECRET,
  );
  if (!guestSession) {
    return null;
  }

  const database = createDatabase(options.env.DB);
  const choir = await database.query.choirs.findFirst({
    where: and(
      eq(choirs.id, guestSession.choirId),
      eq(choirs.guestSessionVersion, guestSession.guestSessionVersion),
    ),
    columns: { id: true },
  });

  if (!choir) {
    return null;
  }

  return {
    kind: "guest",
    choirId: guestSession.choirId,
    guestSessionVersion: guestSession.guestSessionVersion,
  };
}
