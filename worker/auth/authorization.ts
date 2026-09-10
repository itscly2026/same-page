import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "../db/database";
import { choirs, memberships } from "../db/schema";
import type { Principal } from "./principal";

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor() {
    super("Forbidden");
  }
}

export async function requireChoirRead(
  database: Database,
  principal: Principal | null,
  choirId: string,
) {
  if (!principal) {
    throw new AuthorizationError();
  }

  const available = await database.query.choirs.findFirst({ where: and(eq(choirs.id, choirId), isNull(choirs.purgedAt)), columns: { id: true } });
  if (!available) throw new AuthorizationError();
  if (principal.kind === "guest") {
    if (principal.choirId !== choirId) {
      throw new AuthorizationError();
    }
    return { kind: "guest" as const };
  }

  const membership = await findActiveMembership(
    database,
    choirId,
    principal.userId,
  );
  if (!membership) {
    const preview = await database.query.choirs.findFirst({
      where: and(eq(choirs.id, choirId), eq(choirs.isPreviewEntry, true), eq(choirs.guestAdmissionMode, "open")),
      columns: { id: true },
    });
    if (!preview) throw new AuthorizationError();
    return { kind: "preview" as const };
  }
  return { kind: "membership" as const, membership };
}

async function findActiveMembership(
  database: Database,
  choirId: string,
  userId: string,
) {
  const member = await database.query.memberships.findFirst({
    where: and(
      eq(memberships.choirId, choirId),
      eq(memberships.userId, userId),
      eq(memberships.status, "active"),
    ),
  });
  if (!member) return undefined;
  const drive = await database.query.choirs.findFirst({ where: eq(choirs.id, choirId), columns: { ownerMembershipId: true } });
  return { ...member, isOwner: drive?.ownerMembershipId === member.id };
}
