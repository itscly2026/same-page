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
import { findAdmissibleChoir } from "./admission";

export const choirRoutes = new Hono<AppEnvironment>();

choirRoutes.post("/guest/session", async (context) => {
  const parsed = guestSessionRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return admissionDenied(context);
  }
  if (parsed.data.admission === "invite") {
    const limited = await enforceInviteRateLimit(context);
    if (limited) {
      return limited;
    }
  }

  const database = createDatabase(context.env.DB);
  const choir = await findAdmissibleChoir({
    database,
    inviteSecret: context.env.INVITE_SECRET,
    request: parsed.data,
  });
  if (!choir) {
    return admissionDenied(context);
  }

  const expiresAt = Date.now() + GUEST_SESSION_SECONDS * 1000;
  const token = await createGuestSessionToken(
    {
      choirId: choir.id,
      guestSessionVersion: choir.guestSessionVersion,
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

  return context.json({
    choir: serializeChoir(choir),
    entryKind: choir.isPreviewEntry ? "preview" : "admission",
  });
});

choirRoutes.get("/guest/preview-choir", async (context) => {
  const choir = await createDatabase(context.env.DB).query.choirs.findFirst({
    where: and(
      eq(choirs.isPreviewEntry, true),
      eq(choirs.guestAdmissionMode, "open"),
    ),
  });
  if (!choir) return context.json({ error: "not_found" }, 404);
  return context.json({ choir: serializeChoir(choir) });
});

choirRoutes.get("/guest/choirs/:choirId", async (context) => {
  const database = createDatabase(context.env.DB);
  const choir = await database.query.choirs.findFirst({
    where: and(
      eq(choirs.id, context.req.param("choirId")),
      eq(choirs.guestAdmissionMode, "open"),
    ),
    columns: {
      id: true,
      name: true,
      guestAdmissionMode: true,
      isPreviewEntry: true,
    },
  });

  if (!choir) {
    return context.json({ error: "not_found" }, 404);
  }
  return context.json({
    choir: serializeChoir(choir),
    entryKind: choir.isPreviewEntry ? "preview" : "admission",
  });
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
    columns: {
      id: true,
      name: true,
      guestAdmissionMode: true,
      isPreviewEntry: true,
    },
  });
  if (!choir) {
    deleteCookie(context, GUEST_SESSION_COOKIE, { path: "/" });
    return context.json({ error: "unauthorized" }, 401);
  }
  return context.json({
    choir: serializeChoir(choir),
    entryKind: choir.isPreviewEntry ? "preview" : "admission",
  });
});

choirRoutes.delete("/guest/session", (context) => {
  deleteCookie(context, GUEST_SESSION_COOKIE, { path: "/" });
  return context.body(null, 204);
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
      guestAdmissionMode: choirs.guestAdmissionMode,
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
      choir: {
        id: row.choirId,
        name: row.choirName,
        guestAdmissionMode: row.guestAdmissionMode,
      },
    })),
  });
});

choirRoutes.post("/choirs/join", async (context) => {
  const principal = await resolveContextPrincipal(context);
  if (!principal || principal.kind !== "user") {
    return context.json({ error: "unauthorized" }, 401);
  }

  const parsed = joinChoirRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return admissionDenied(context);
  }
  if (parsed.data.admission === "invite") {
    const limited = await enforceInviteRateLimit(context);
    if (limited) {
      return limited;
    }
  }

  const database = createDatabase(context.env.DB);
  const choir = await findAdmissibleChoir({
    database,
    inviteSecret: context.env.INVITE_SECRET,
    request: parsed.data,
  });
  if (!choir) {
    return admissionDenied(context);
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
  if (choir.isPreviewEntry) {
    return context.json({ error: "preview_membership_not_available" }, 403);
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

choirRoutes.get("/choirs/current-guest/join-state", async (context) => {
  const principal = await resolveContextPrincipal(context);
  if (!principal || principal.kind !== "user") {
    return context.json({ error: "unauthorized" }, 401);
  }
  const guest = await resolveContextGuestPrincipal(context);
  if (!guest) {
    return context.json({ error: "guest_session_required" }, 401);
  }

  const database = createDatabase(context.env.DB);
  const choir = await database.query.choirs.findFirst({
    where: eq(choirs.id, guest.choirId),
  });
  if (!choir) {
    return context.json({ error: "guest_session_required" }, 401);
  }
  if (choir.isPreviewEntry) {
    return context.json({ error: "preview_membership_not_available" }, 403);
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
  return context.json({
    status: existing ? "joined" : "display-name-required",
    choir: serializeChoir(choir),
  });
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
  if (choir.isPreviewEntry) {
    return context.json({ error: "preview_membership_not_available" }, 403);
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
  const choir = await database.query.choirs.findFirst({
    where: eq(choirs.id, choirId),
    columns: { guestAdmissionMode: true },
  });
  if (!choir) {
    return context.json({ error: "not_found" }, 404);
  }
  if (choir.guestAdmissionMode !== "invite") {
    return context.json({ error: "join_code_not_available" }, 409);
  }

  const joinCode = generateJoinCode();
  const joinCodeHash = await hashJoinCode(
    joinCode,
    context.env.INVITE_SECRET,
  );
  const [updated] = await database
    .update(choirs)
    .set({
      joinCodeHash,
      guestSessionVersion: sql`${choirs.guestSessionVersion} + 1`,
    })
    .where(eq(choirs.id, choirId))
    .returning({ id: choirs.id });

  if (!updated) {
    return context.json({ error: "not_found" }, 404);
  }

  return context.json({ joinCode });
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

function admissionDenied(
  context: Context<AppEnvironment>,
) {
  return context.json({ error: "guest_admission_denied" }, 401);
}

function serializeMembership(
  membership: {
    id: string;
    displayName: string;
    role: "admin" | "member";
  },
  choir: {
    id: string;
    name: string;
    guestAdmissionMode: "invite" | "open";
  },
) {
  return {
    id: membership.id,
    displayName: membership.displayName,
    role: membership.role,
    choir: {
      id: choir.id,
      name: choir.name,
      guestAdmissionMode: choir.guestAdmissionMode,
    },
  };
}

function serializeChoir(choir: {
  id: string;
  name: string;
  guestAdmissionMode: "invite" | "open";
}) {
  return {
    id: choir.id,
    name: choir.name,
    guestAdmissionMode: choir.guestAdmissionMode,
  };
}
