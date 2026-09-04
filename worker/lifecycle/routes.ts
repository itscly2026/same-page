import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "../auth/create-auth";
import { AuthorizationError, requireChoirAdmin } from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import { createDatabase } from "../db/database";
import type { AppEnvironment } from "../env";
import { RECOVERY_PERIOD_MS } from "./cleanup";

export const lifecycleRoutes = new Hono<AppEnvironment>();
const FRESH_AUTH_MS = 10 * 60 * 1000;
const mutationSchema = z.object({ expectedRevision: z.number().int().nonnegative(), action: z.enum(["remove", "restore", "promote", "demote"]) });

lifecycleRoutes.get("/user/lifecycle", async (context) => {
  const session = await createAuth(context.env, context.executionCtx).api.getSession({ headers: context.req.raw.headers });
  if (!session) return context.json({ error: "unauthorized" }, 401);
  const deletion = await context.env.DB.prepare("SELECT deletion_id AS deletionId, expires_at AS expiresAt, auth_method AS authMethod FROM user_lifecycle WHERE user_id = ?").bind(session.user.id).first();
  const challenge = await context.env.DB.prepare(`SELECT created_at FROM lifecycle_reauthentication
    WHERE user_id = ? AND previous_session_id <> ? AND expires_at > ? AND created_at <= ?`).bind(session.user.id, session.session.id, Date.now(), session.session.createdAt.getTime()).first();
  const methods = await context.env.DB.prepare("SELECT provider_id AS method FROM account WHERE user_id = ?").bind(session.user.id).all<{ method: string }>();
  const drives = await context.env.DB.prepare(`SELECT memberships.id, memberships.choir_id AS choirId,
    choirs.name, memberships.display_name AS displayName, memberships.role, memberships.status,
    memberships.lifecycle_revision AS revision, memberships.removed_at AS removedAt,
    CASE WHEN memberships.role = 'admin' AND memberships.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM memberships AS other WHERE other.choir_id = memberships.choir_id
        AND other.id <> memberships.id AND other.status = 'active' AND other.role = 'admin') THEN 1 ELSE 0 END AS lastAdmin
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
  await requireChoirAdmin(createDatabase(context.env.DB), await resolveContextPrincipal(context), choirId);
  const result = await context.env.DB.prepare(`SELECT id, display_name AS displayName, role, status,
    removed_at AS removedAt, lifecycle_revision AS revision, removed_for_deletion_id IS NOT NULL AS userDeleted,
    CASE WHEN status = 'removed' AND removed_at > ? AND removed_for_deletion_id IS NULL THEN 1 ELSE 0 END AS recoverable
    FROM memberships WHERE choir_id = ? ORDER BY status, display_name`).bind(Date.now() - RECOVERY_PERIOD_MS, choirId).all();
  return context.json({ memberships: result.results });
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
  const actor = selfLeaving ? null : await requireChoirAdmin(createDatabase(context.env.DB), principal, choirId);
  const { action, expectedRevision } = body.data;
  const now = Date.now();
  const change = action === "remove"
    ? "status = 'removed', removed_at = ?, removed_for_deletion_id = NULL"
    : action === "restore"
      ? "status = 'active', role = 'member', removed_at = NULL"
      : `role = '${action === "promote" ? "admin" : "member"}'`;
  const result = await context.env.DB.prepare(`UPDATE memberships SET ${change}, lifecycle_revision = lifecycle_revision + 1, last_lifecycle_action = ?
    WHERE id = ? AND choir_id = ? AND lifecycle_revision = ? AND removed_for_deletion_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id)
      AND (? = 1 OR EXISTS (SELECT 1 FROM memberships AS actor WHERE actor.id = ? AND actor.status = 'active' AND actor.role = 'admin'))
      AND ${action === "restore" ? "status = 'removed' AND removed_at > ?" : "status = 'active'"}`)
    .bind(...(action === "remove" ? [now] : []), action, membershipId, choirId, expectedRevision,
      selfLeaving ? 1 : 0, actor?.id ?? "", ...(action === "restore" ? [now - RECOVERY_PERIOD_MS] : [])).run();
  if (result.meta.changes !== 1) {
    const retry = await context.env.DB.prepare(`SELECT id FROM memberships WHERE id = ? AND choir_id = ?
      AND lifecycle_revision = ? AND last_lifecycle_action = ?`).bind(membershipId, choirId, expectedRevision + 1, action).first();
    if (!retry) return context.json({ error: "membership_conflict" }, 409);
  }
  return context.body(null, 204);
});
