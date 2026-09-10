import { Hono } from "hono";
import { z } from "zod";
import { displayNameSchema, driveNameSchema } from "../../src/shared/choirs";
import { AuthorizationError } from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import type { AppEnvironment } from "../env";
import { readPermissionMember } from "../permissions/access";
import { limitDriveMutation } from "../security/drive-rate-limit";
import { provisionChoir } from "./provision";

export const trialRoutes = new Hono<AppEnvironment>();
const createSchema = z.object({ name: driveNameSchema, displayName: displayNameSchema }).strict();
const confirmationSchema = z.object({ confirm: z.literal(true) }).strict();

trialRoutes.post("/choirs", async context => {
  const principal = await resolveContextPrincipal(context);
  if (principal?.kind !== "user") return context.json({ error: "unauthorized" }, 401);
  if (context.req.header("x-same-page-owner-user-id") && context.req.header("x-same-page-owner-user-id") !== principal.userId) return context.json({ error: "identity_changed" }, 403);
  const verified = await context.env.DB.prepare(`SELECT id FROM user WHERE id = ? AND
    email_verified = 1`)
    .bind(principal.userId).first();
  if (!verified) return context.json({ error: "identity_verification_required" }, 403);
  const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
  const limited = await limitDriveMutation(context, principal.userId, "create-drive", 3, 24 * 60 * 60_000);
  if (limited) return limited;
  const created = await provisionChoir({ binding: context.env.DB, ownerUserId: principal.userId,
    ownerDisplayName: parsed.data.displayName, choirName: parsed.data.name,
    inviteSecret: context.env.INVITE_SECRET, freeTrial: true });
  return context.json({ choirId: created.choirId }, 201);
});

trialRoutes.get("/choirs/:choirId/usage", async context => {
  const choirId = context.req.param("choirId");
  await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  const usage = await context.env.DB.prepare(`SELECT plan, storage_used_bytes AS usedBytes, storage_limit_bytes AS limitBytes,
    score_limit AS scoreLimit, member_limit AS memberLimit,
    (SELECT count(*) FROM scores WHERE choir_id = c.id AND trashed_at IS NULL) AS scoreCount,
    (SELECT count(*) FROM memberships WHERE choir_id = c.id AND status = 'active') AS memberCount
    FROM choirs c WHERE id = ? AND purged_at IS NULL`).bind(choirId).first();
  return context.json(usage);
});

trialRoutes.post("/choirs/:choirId/purge", async context => {
  const choirId = context.req.param("choirId");
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  if (!actor.isOwner || (context.req.header("x-same-page-owner-user-id") && context.req.header("x-same-page-owner-user-id") !== actor.userId)) throw new AuthorizationError();
  const body = z.object({ confirm: z.literal(true), name: driveNameSchema }).strict().safeParse(await context.req.json().catch(() => null));
  if (!body.success) return context.json({ error: "confirmation_required" }, 400);
  const limited = await limitDriveMutation(context, actor.userId, "purge", 20);
  if (limited) return limited;
  const result = await context.env.DB.prepare(`UPDATE choirs SET purged_at = ?, guest_session_version = guest_session_version + 1
    WHERE id = ? AND owner_membership_id = ? AND name = ? AND purged_at IS NULL
    AND EXISTS (SELECT 1 FROM membership_capabilities WHERE id = ? AND is_owner = 1)`)
    .bind(Date.now(), choirId, actor.id, body.data.name, actor.id).run();
  return result.meta.changes ? context.body(null, 204) : context.json({ error: "confirmation_mismatch" }, 409);
});

trialRoutes.post("/choirs/:choirId/scores/:scoreId/purge", async context => {
  const { choirId, scoreId } = context.req.param();
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  if (!actor.isOwner || (context.req.header("x-same-page-owner-user-id") && context.req.header("x-same-page-owner-user-id") !== actor.userId)) throw new AuthorizationError();
  if (!confirmationSchema.safeParse(await context.req.json().catch(() => null)).success) return context.json({ error: "confirmation_required" }, 400);
  const limited = await limitDriveMutation(context, actor.userId, "purge", 20);
  if (limited) return limited;
  const now = Date.now();
  const result = await context.env.DB.prepare(`UPDATE scores SET purged_at = ? WHERE id = ? AND choir_id = ?
    AND trashed_at IS NOT NULL AND trash_expires_at > ? AND purged_at IS NULL
    AND EXISTS (SELECT 1 FROM membership_capabilities WHERE id = ? AND is_owner = 1)`)
    .bind(now, scoreId, choirId, now, actor.id).run();
  return result.meta.changes ? context.body(null, 204) : context.json({ error: "score_not_found" }, 404);
});

trialRoutes.post("/choirs/:choirId/scores/:scoreId/versions/:versionId/purge", async context => {
  const { choirId, scoreId, versionId } = context.req.param();
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  if (!actor.isOwner || (context.req.header("x-same-page-owner-user-id") && context.req.header("x-same-page-owner-user-id") !== actor.userId)) throw new AuthorizationError();
  if (!confirmationSchema.safeParse(await context.req.json().catch(() => null)).success) return context.json({ error: "confirmation_required" }, 400);
  const limited = await limitDriveMutation(context, actor.userId, "purge", 20);
  if (limited) return limited;
  const now = Date.now();
  const result = await context.env.DB.prepare(`UPDATE score_versions SET purged_at = ? WHERE id = ? AND score_id = ? AND choir_id = ?
    AND purged_at IS NULL AND state = 'ready' AND candidate_expires_at IS NULL AND retention_expires_at > ?
    AND EXISTS (SELECT 1 FROM scores WHERE id = ? AND trashed_at IS NULL AND current_version_id <> score_versions.id)
    AND EXISTS (SELECT 1 FROM membership_capabilities WHERE id = ? AND is_owner = 1)`)
    .bind(now, versionId, scoreId, choirId, now, scoreId, actor.id).run();
  return result.meta.changes ? context.body(null, 204) : context.json({ error: "version_conflict" }, 409);
});
