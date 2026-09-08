import { permissionSetSchema } from "../../src/shared/drive-permissions";
import { memberCapabilities, readPermissionMember, requireOperation } from "../permissions/access";
import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../auth/create-auth";
import { AuthorizationError } from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import type { AppEnvironment } from "../env";
import { RECOVERY_PERIOD_MS } from "./cleanup";

export const lifecycleRoutes = new Hono<AppEnvironment>();
const FRESH_AUTH_MS = 10 * 60 * 1000;
const mutationSchema = z.object({ expectedRevision: z.number().int().nonnegative(), action: z.enum(["remove", "restore"]) });

lifecycleRoutes.get("/user/lifecycle", async (context) => {
  const session = await createAuth(context.env, context.executionCtx).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "unauthorized" }, 401);
  const deletion = await context.env.DB.prepare("SELECT deletion_id AS deletionId, expires_at AS expiresAt, auth_method AS authMethod FROM user_lifecycle WHERE user_id = ?").bind(session.user.id).first();
  const challenge = await context.env.DB.prepare(`SELECT created_at FROM lifecycle_reauthentication
    WHERE user_id = ? AND previous_session_id <> ? AND expires_at > ? AND created_at <= ?`).bind(session.user.id, session.session.id, Date.now(), session.session.createdAt.getTime()).first();
  const methods = await context.env.DB.prepare("SELECT provider_id AS method FROM account WHERE user_id = ?").bind(session.user.id).all<{ method: string }>();
  const drives = await context.env.DB.prepare(`SELECT memberships.id, memberships.choir_id AS choirId,
    choirs.name, choirs.is_preview_entry AS isPreviewEntry, memberships.display_name AS displayName, memberships.status,
    memberships.lifecycle_revision AS revision, memberships.removed_at AS removedAt,
    choirs.owner_membership_id = memberships.id AS isOwner
    FROM memberships JOIN choirs ON choirs.id = memberships.choir_id WHERE memberships.user_id = ?`).bind(session.user.id).all();
  context.header("Cache-Control", "no-store");
  return context.json({ userId: session.user.id, deletion, reauthenticated: Boolean(challenge), methods: methods.results.map((row) => row.method), memberships: drives.results });
});

lifecycleRoutes.post("/user/lifecycle/reauthenticate", async (context) => {
  const principal = await resolveContextPrincipal(context);
  if (principal?.kind !== "user") return context.json({ error: "unauthorized" }, 401);
  const session = await createAuth(context.env, context.executionCtx).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "unauthorized" }, 401);
  const body = await context.req.json().catch(() => null);
  if (body?.expectedUserId !== principal.userId) return context.json({ error: "identity_changed" }, 409);
  const now = Date.now();
  await context.env.DB.prepare(`INSERT INTO lifecycle_reauthentication
    (user_id, previous_session_id, allowed_methods, created_at, expires_at)
    SELECT ?, ?, json_group_array(provider_id), ?, ? FROM account WHERE user_id = ?
    ON CONFLICT(user_id) DO UPDATE SET previous_session_id = excluded.previous_session_id,
      allowed_methods = excluded.allowed_methods, created_at = excluded.created_at, expires_at = excluded.expires_at`)
    .bind(principal.userId, session.session.id, now, now + FRESH_AUTH_MS, principal.userId).run();
  return context.body(null, 204);
});

lifecycleRoutes.post("/user/lifecycle/delete", async (context) => {
  const session = await createAuth(context.env, context.executionCtx).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "unauthorized" }, 401);
  const confirmation = await context.req.json().catch(() => null);
  if (confirmation?.expectedUserId !== session.user.id) return context.json({ error: "identity_changed" }, 409);
  if (confirmation?.confirm !== true) return context.json({ error: "confirmation_required" }, 400);
  const now = Date.now();
  const deleted = await context.env.DB.prepare(`INSERT INTO user_lifecycle
    (user_id, deletion_id, auth_method, deleted_at, expires_at)
    SELECT ?, ?, methods.method, ?, ? FROM lifecycle_reauthentication AS challenge
    JOIN session_auth_methods AS methods ON methods.session_id = ?
    WHERE challenge.user_id = ? AND challenge.previous_session_id <> ?
      AND challenge.created_at <= ? AND challenge.expires_at > ?
      AND EXISTS (SELECT 1 FROM json_each(challenge.allowed_methods) WHERE value = methods.method)
      AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = ?)`)
    .bind(session.user.id, crypto.randomUUID(), now, now + RECOVERY_PERIOD_MS, session.session.id,
      session.user.id, session.session.id, session.session.createdAt.getTime(), now, session.user.id).run();
  if (deleted.meta.changes === 0) return context.json({ error: "reauthentication_required" }, 409);
  return context.body(null, 204);
});

lifecycleRoutes.post("/user/lifecycle/restore", async (context) => {
  const session = await createAuth(context.env, context.executionCtx).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "unauthorized" }, 401);
  const body = await context.req.json().catch(() => null);
  if (body?.confirm !== true || typeof body.deletionId !== "string") return context.json({ error: "confirmation_required" }, 400);
  const now = Date.now();
  const restored = await context.env.DB.prepare(`DELETE FROM user_lifecycle WHERE user_id = ? AND deletion_id = ?
    AND expires_at > ? AND deleted_at <= ? AND ? >= ?
    AND EXISTS (SELECT 1 FROM session_auth_methods WHERE session_id = ? AND method = user_lifecycle.auth_method)`)
    .bind(session.user.id, body.deletionId, now, session.session.createdAt.getTime(), session.session.createdAt.getTime(), now - FRESH_AUTH_MS, session.session.id).run();
  if (!restored.meta.changes) return context.json({ error: "recovery_unavailable" }, 409);
  return context.body(null, 204);
});

lifecycleRoutes.get("/choirs/:choirId/memberships", async (context) => {
  const choirId = context.req.param("choirId");
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  const capabilities = memberCapabilities(actor);
  const canManageLifecycle = actor.isOwner || capabilities.operations.operations.includes("removeMembers");
  const result = await context.env.DB.prepare(`SELECT m.id, m.display_name AS displayName, m.status, m.permissions, m.management_scope AS management,
    m.removed_at AS removedAt, m.lifecycle_revision AS revision, m.removed_for_deletion_id IS NOT NULL AS userDeleted,
    c.owner_membership_id = m.id AS isOwner,
    CASE WHEN m.status = 'removed' AND m.removed_at > ? AND m.removed_for_deletion_id IS NULL THEN 1 ELSE 0 END AS recoverable
    FROM memberships m JOIN choirs c ON c.id = m.choir_id WHERE m.choir_id = ? AND (m.status = 'active' OR ? = 1) ORDER BY m.status, m.display_name`).bind(Date.now() - RECOVERY_PERIOD_MS, choirId, Number(canManageLifecycle)).all<{ id: string; displayName: string; status: string; revision: number; removedAt: number | null; userDeleted: number; recoverable: number; permissions: string; management: string; isOwner: number }>();
  const members = result.results.map(row => ({
    id: row.id, displayName: row.displayName, status: row.status, revision: row.revision, isOwner: row.isOwner,
    operations: permissionSetSchema.parse(JSON.parse(row.permissions)), management: permissionSetSchema.parse(JSON.parse(row.management)),
    ...(canManageLifecycle ? { removedAt: row.removedAt, userDeleted: row.userDeleted, recoverable: row.recoverable } : {}),
  }));

  return context.json({ memberships: members, capabilities, actorId: actor.id });
});

lifecycleRoutes.post("/choirs/:choirId/memberships/:membershipId", async (context) => {
  const { choirId, membershipId } = context.req.param();
  const principal = await resolveContextPrincipal(context);
  if (principal?.kind !== "user") throw new AuthorizationError();
  const body = mutationSchema.safeParse(await context.req.json().catch(() => null));
  if (!body.success) return context.json({ error: "invalid_request" }, 400);
  const target = await context.env.DB.prepare("SELECT user_id FROM memberships WHERE id = ? AND choir_id = ?").bind(membershipId, choirId).first<{ user_id: string }>();
  if (!target) return context.json({ error: "membership_not_found" }, 404);
  const selfLeaving = target.user_id === principal.userId && body.data.action === "remove";
  const actor = selfLeaving ? null : await requireOperation(context.env.DB, principal, choirId, "removeMembers");
  const { action, expectedRevision } = body.data;
  const now = Date.now();
  const change = action === "remove"
    ? "status = 'removed', removed_at = ?, removed_for_deletion_id = NULL"
    : "status = 'active', removed_at = NULL";
  const result = await context.env.DB.prepare(`UPDATE memberships SET ${change}, lifecycle_revision = lifecycle_revision + 1, last_lifecycle_action = ?
    WHERE id = ? AND choir_id = ? AND lifecycle_revision = ? AND removed_for_deletion_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id)
      AND (? = 1 OR EXISTS (SELECT 1 FROM memberships AS actor WHERE actor.id = ? AND actor.status = 'active' AND (EXISTS (SELECT 1 FROM membership_capabilities WHERE id = actor.id AND removeMembers = 1))))
      AND NOT EXISTS (SELECT 1 FROM choirs WHERE owner_membership_id = memberships.id)
      AND (? = 1 OR EXISTS (SELECT 1 FROM choirs WHERE id = memberships.choir_id AND owner_membership_id = ?) OR NOT (json_array_length(management_scope, '$.operations') > 0 OR json_extract(management_scope, '$.sharedLayers') = 'all' OR json_array_length(management_scope, '$.sharedLayers') > 0))
      AND ${action === "restore" ? "status = 'removed' AND removed_at > ?" : "status = 'active'"}`)
    .bind(...(action === "remove" ? [now] : []), action, membershipId, choirId, expectedRevision,
      selfLeaving ? 1 : 0, actor?.id ?? "", selfLeaving ? 1 : 0, actor?.id ?? "", ...(action === "restore" ? [now - RECOVERY_PERIOD_MS] : [])).run();
  if (result.meta.changes !== 1) {
    const retry = await context.env.DB.prepare(`SELECT id FROM memberships WHERE id = ? AND choir_id = ?
      AND lifecycle_revision = ? AND last_lifecycle_action = ?`).bind(membershipId, choirId, expectedRevision + 1, action).first();
    if (!retry) return context.json({ error: "membership_conflict" }, 409);
  }
  return context.body(null, 204);
});
