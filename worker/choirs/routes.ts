import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";

import {
  guestSessionRequestSchema,
  joinChoirRequestSchema,
  joinCurrentGuestRequestSchema,
} from "../../src/shared/choirs";
import { requireChoirAdmin } from "../auth/authorization";
import {
  resolveContextGuestPrincipal,
  resolveContextPrincipal,
} from "../auth/context-principal";
import { createDatabase } from "../db/database";
import { choirs, memberships } from "../db/schema";
import type { AppEnvironment } from "../env";
import {
  createGuestSessionToken,
  GUEST_SESSION_COOKIE,
  GUEST_SESSION_SECONDS,
} from "../security/guest-session";
import {
  generateJoinCode,
  hashJoinCode,
  hashRateLimitIdentity,
} from "../security/join-code";
import { consumeRateLimit } from "../security/rate-limit";

export const choirRoutes = new Hono<AppEnvironment>();

choirRoutes.post("/guest/session", async (context) => {
  const limited = await enforceInviteRateLimit(context);
  if (limited) {
    return limited;
  }

  const parsed = guestSessionRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return invalidInvite(context);
  }

  const database = createDatabase(context.env.DB);
  const joinCodeHash = await hashJoinCode(
    parsed.data.joinCode,
    context.env.INVITE_SECRET,
  );
  const choir = await database.query.choirs.findFirst({
    where: eq(choirs.joinCodeHash, joinCodeHash),
  });
  if (!choir) {
    return invalidInvite(context);
  }

  const expiresAt = Date.now() + GUEST_SESSION_SECONDS * 1000;
  const token = await createGuestSessionToken(
    {
      choirId: choir.id,
      joinCodeVersion: choir.joinCodeVersion,
      expiresAt,
    },
    context.env.INVITE_SECRET,
  );
  setCookie(context, GUEST_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(context.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: GUEST_SESSION_SECONDS,
  });

  return context.json({ choir: { id: choir.id, name: choir.name } });
});

choirRoutes.get("/guest/session", async (context) => {
  const principal = await resolveContextGuestPrincipal(context);
  if (!principal) {
    deleteCookie(context, GUEST_SESSION_COOKIE, { path: "/" });
    return context.json({ error: "unauthorized" }, 401);
  }

  const database = createDatabase(context.env.DB);
  const choir = await database.query.choirs.findFirst({
    where: eq(choirs.id, principal.choirId),
    columns: { id: true, name: true },
  });
  if (!choir) {
    deleteCookie(context, GUEST_SESSION_COOKIE, { path: "/" });
    return context.json({ error: "unauthorized" }, 401);
  }
  return context.json({ choir });
});

choirRoutes.get("/choirs", async (context) => {
  const principal = await resolveContextPrincipal(context);
  if (!principal || principal.kind !== "user") {
    return context.json({ error: "unauthorized" }, 401);
  }

  const database = createDatabase(context.env.DB);
  const rows = await database
    .select({
      id: memberships.id,
      displayName: memberships.displayName,
      role: memberships.role,
      choirId: choirs.id,
      choirName: choirs.name,
    })
    .from(memberships)
    .innerJoin(choirs, eq(memberships.choirId, choirs.id))
    .where(
      and(
        eq(memberships.userId, principal.userId),
        eq(memberships.status, "active"),
      ),
    );

  return context.json({
    memberships: rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      role: row.role,
      choir: { id: row.choirId, name: row.choirName },
    })),
  });
});

choirRoutes.post("/choirs/join", async (context) => {
  const limited = await enforceInviteRateLimit(context);
  if (limited) {
    return limited;
  }

  const principal = await resolveContextPrincipal(context);
  if (!principal || principal.kind !== "user") {
    return context.json({ error: "unauthorized" }, 401);
  }

  const parsed = joinChoirRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return invalidInvite(context);
  }

  const database = createDatabase(context.env.DB);
  const joinCodeHash = await hashJoinCode(
    parsed.data.joinCode,
    context.env.INVITE_SECRET,
  );
  const choir = await database.query.choirs.findFirst({
    where: eq(choirs.joinCodeHash, joinCodeHash),
  });
  if (!choir) {
    return invalidInvite(context);
  }

  const existing = await database.query.memberships.findFirst({
    where: and(
      eq(memberships.choirId, choir.id),
      eq(memberships.userId, principal.userId),
    ),
  });
  if (existing?.status === "removed") {
    return context.json({ error: "membership_requires_admin" }, 403);
  }
  if (existing) {
    return context.json({ membership: serializeMembership(existing, choir) });
  }

  const membership = {
    id: crypto.randomUUID(),
    choirId: choir.id,
    userId: principal.userId,
    displayName: parsed.data.displayName,
    role: "member" as const,
    status: "active" as const,
  };
  await database.insert(memberships).values(membership);

  return context.json(
    { membership: serializeMembership(membership, choir) },
    201,
  );
});

choirRoutes.post("/choirs/join-current-guest", async (context) => {
  const principal = await resolveContextPrincipal(context);
  if (!principal || principal.kind !== "user") {
    return context.json({ error: "unauthorized" }, 401);
  }

  const guest = await resolveContextGuestPrincipal(context);
  if (!guest) {
    return context.json({ error: "guest_session_required" }, 401);
  }

  const parsed = joinCurrentGuestRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: "invalid_display_name" }, 400);
  }

  const database = createDatabase(context.env.DB);
  const choir = await database.query.choirs.findFirst({
    where: eq(choirs.id, guest.choirId),
  });
  if (!choir) {
    return context.json({ error: "guest_session_required" }, 401);
  }

  const existing = await database.query.memberships.findFirst({
    where: and(
      eq(memberships.choirId, choir.id),
      eq(memberships.userId, principal.userId),
    ),
  });
  if (existing?.status === "removed") {
    return context.json({ error: "membership_requires_admin" }, 403);
  }
  if (existing) {
    deleteCookie(context, GUEST_SESSION_COOKIE, { path: "/" });
    return context.json({ membership: serializeMembership(existing, choir) });
  }

  const membership = {
    id: crypto.randomUUID(),
    choirId: choir.id,
    userId: principal.userId,
    displayName: parsed.data.displayName,
    role: "member" as const,
    status: "active" as const,
  };
  await database.insert(memberships).values(membership);
  deleteCookie(context, GUEST_SESSION_COOKIE, { path: "/" });

  return context.json(
    { membership: serializeMembership(membership, choir) },
    201,
  );
});

choirRoutes.post("/choirs/:choirId/join-code/rotate", async (context) => {
  const database = createDatabase(context.env.DB);
  const principal = await resolveContextPrincipal(context);
  const choirId = context.req.param("choirId");
  await requireChoirAdmin(database, principal, choirId);

  const joinCode = generateJoinCode();
  const joinCodeHash = await hashJoinCode(
    joinCode,
    context.env.INVITE_SECRET,
  );
  const [updated] = await database
    .update(choirs)
    .set({
      joinCodeHash,
      joinCodeVersion: sql`${choirs.joinCodeVersion} + 1`,
    })
    .where(eq(choirs.id, choirId))
    .returning({ joinCodeVersion: choirs.joinCodeVersion });

  if (!updated) {
    return context.json({ error: "not_found" }, 404);
  }

  return context.json({ joinCode, joinCodeVersion: updated.joinCodeVersion });
});

async function enforceInviteRateLimit(
  context: Context<AppEnvironment>,
) {
  const clientIdentity =
    context.req.header("CF-Connecting-IP") ?? "local-development";
  const key = await hashRateLimitIdentity(
    clientIdentity,
    context.env.INVITE_SECRET,
  );
  const result = await consumeRateLimit(context.env.DB, key, {
    maxAttempts: 10,
    windowMs: 60_000,
  });

  if (result.allowed) {
    return null;
  }

  context.header("Retry-After", String(result.retryAfterSeconds));
  return context.json({ error: "try_again_later" }, 429);
}

function invalidInvite(
  context: Context<AppEnvironment>,
) {
  return context.json({ error: "invalid_or_expired_invite" }, 401);
}

function serializeMembership(
  membership: {
    id: string;
    displayName: string;
    role: "admin" | "member";
  },
  choir: { id: string; name: string },
) {
  return {
    id: membership.id,
    displayName: membership.displayName,
    role: membership.role,
    choir: { id: choir.id, name: choir.name },
  };
}
