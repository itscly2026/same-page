import { and, eq } from "drizzle-orm";

import type { Database } from "../db/database";
import { memberships, sharedLayerEditGrants } from "../db/schema";
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
    throw new AuthorizationError();
  }
  return { kind: "membership" as const, membership };
}

export async function requireChoirAdmin(
  database: Database,
  principal: Principal | null,
  choirId: string,
) {
  if (!principal || principal.kind !== "user") {
    throw new AuthorizationError();
  }

  const membership = await findActiveMembership(
    database,
    choirId,
    principal.userId,
  );
  if (!membership || membership.role !== "admin") {
    throw new AuthorizationError();
  }
  return membership;
}

export async function requireSharedLayerEdit(
  database: Database,
  principal: Principal | null,
  choirId: string,
  sharedLayerId: string,
) {
  if (!principal || principal.kind !== "user") {
    throw new AuthorizationError();
  }

  const membership = await findActiveMembership(
    database,
    choirId,
    principal.userId,
  );
  if (!membership) {
    throw new AuthorizationError();
  }
  if (membership.role === "admin") {
    return membership;
  }

  const grant = await database.query.sharedLayerEditGrants.findFirst({
    where: and(
      eq(sharedLayerEditGrants.choirId, choirId),
      eq(sharedLayerEditGrants.sharedLayerId, sharedLayerId),
      eq(sharedLayerEditGrants.membershipId, membership.id),
    ),
  });
  if (!grant) {
    throw new AuthorizationError();
  }
  return membership;
}

export async function requirePersonalLayerOwner(
  database: Database,
  principal: Principal | null,
  choirId: string,
  ownerUserId: string,
) {
  if (
    !principal ||
    principal.kind !== "user" ||
    principal.userId !== ownerUserId
  ) {
    throw new AuthorizationError();
  }

  const membership = await findActiveMembership(
    database,
    choirId,
    principal.userId,
  );
  if (!membership) {
    throw new AuthorizationError();
  }
  return membership;
}

async function findActiveMembership(
  database: Database,
  choirId: string,
  userId: string,
) {
  return database.query.memberships.findFirst({
    where: and(
      eq(memberships.choirId, choirId),
      eq(memberships.userId, userId),
      eq(memberships.status, "active"),
    ),
  });
}
