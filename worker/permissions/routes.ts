import { Hono } from "hono";
import { z } from "zod";
import { isDelegated, mayChangePermissions, permissionSetSchema } from "../../src/shared/drive-permissions";
import { AuthorizationError } from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import type { AppEnvironment } from "../env";
import { memberCapabilities, readPermissionMember } from "./access";

export const permissionRoutes = new Hono<AppEnvironment>();
const updateSchema = z.object({ expectedRevision: z.number().int().nonnegative(), operations: permissionSetSchema, management: permissionSetSchema }).strict();
permissionRoutes.put("/choirs/:choirId/memberships/:membershipId/permissions", async context => {
  const { choirId, membershipId } = context.req.param();
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  const parsed = updateSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "invalid_permissions" }, 400);
  const target = await context.env.DB.prepare(`SELECT display_name, permissions, management_scope, lifecycle_revision
    FROM memberships WHERE id = ? AND choir_id = ? AND status = 'active'`).bind(membershipId, choirId)
    .first<{ display_name: string; permissions: string; management_scope: string; lifecycle_revision: number }>();
  if (!target) return context.json({ error: "membership_not_found" }, 404);
  if (target.lifecycle_revision !== parsed.data.expectedRevision) return context.json({ error: "membership_conflict" }, 409);
  const before = { operations: permissionSetSchema.parse(JSON.parse(target.permissions)), management: permissionSetSchema.parse(JSON.parse(target.management_scope)) };
  const after = parsed.data;
  const capabilities = memberCapabilities(actor);
  const owner = await context.env.DB.prepare("SELECT owner_membership_id FROM choirs WHERE id = ?").bind(choirId).first<{ owner_membership_id: string }>();
  if (actor.isOwner !== (owner?.owner_membership_id === actor.id)) return context.json({ error: "membership_conflict" }, 409);
  if (!actor.isOwner && (actor.id === membershipId || owner?.owner_membership_id === membershipId || isDelegated(before.management)
    || isDelegated(after.management) || !isDelegated(capabilities.management)
    || !mayChangePermissions(capabilities.management, before.operations, after.operations))) throw new AuthorizationError();
  const slots = [...(after.operations.sharedLayers === "all" ? [] : after.operations.sharedLayers), ...(after.management.sharedLayers === "all" ? [] : after.management.sharedLayers)];
  if (slots.length) {
    const valid = await context.env.DB.prepare("SELECT slot FROM choir_shared_layer_settings WHERE choir_id = ?").bind(choirId).all<{ slot: string }>();
    if (slots.some(slot => !valid.results.some(row => row.slot === slot))) return context.json({ error: "invalid_layer" }, 400);
  }
  const changeId = crypto.randomUUID();
  // Both membership revisions and the ownership observed during authorization must still match.
  const condition = `id = ? AND choir_id = ? AND status = 'active' AND lifecycle_revision = ?
    AND EXISTS (SELECT 1 FROM membership_capabilities actor WHERE actor.id = ? AND actor.lifecycle_revision = ?)
    AND EXISTS (SELECT 1 FROM choirs WHERE id = ? AND owner_membership_id = ?)`;
  const bindings = [membershipId, choirId, target.lifecycle_revision, actor.id, actor.lifecycleRevision, choirId, owner!.owner_membership_id];
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO permission_changes SELECT ?, ?, ?, display_name, ?, ?, ? FROM memberships WHERE ${condition}`)
      .bind(changeId, choirId, actor.displayName, JSON.stringify(before), JSON.stringify({ operations: after.operations, management: after.management }), Date.now(), ...bindings),
    context.env.DB.prepare(`UPDATE memberships SET permissions = ?, management_scope = ?, lifecycle_revision = lifecycle_revision + 1
      WHERE ${condition}`).bind(JSON.stringify(after.operations), JSON.stringify(after.management), ...bindings),
  ]);
  return results[1].meta.changes ? context.body(null, 204) : context.json({ error: "membership_conflict" }, 409);
});
permissionRoutes.post("/choirs/:choirId/ownership", async context => {
  const choirId = context.req.param("choirId");
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  if (!actor.isOwner) throw new AuthorizationError();
  const parsed = z.object({ membershipId: z.string(), confirm: z.literal(true) }).strict().safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || parsed.data.membershipId === actor.id) return context.json({ error: "invalid_transfer" }, 400);
  const targetId = parsed.data.membershipId;
  const condition = `id = ? AND owner_membership_id = ? AND EXISTS (SELECT 1 FROM membership_capabilities WHERE id = ? AND choir_id = ?)`;
  const bindings = [choirId, actor.id, targetId, choirId];
  const result = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO permission_changes SELECT ?, id, ?, (SELECT display_name FROM memberships WHERE id = ?), ?, ?, ? FROM choirs WHERE ${condition}`)
      .bind(crypto.randomUUID(), actor.displayName, targetId, JSON.stringify({ ownerMembershipId: actor.id }), JSON.stringify({ ownerMembershipId: targetId }), Date.now(), ...bindings),
    context.env.DB.prepare(`UPDATE choirs SET owner_membership_id = ? WHERE ${condition}`).bind(targetId, ...bindings),
  ]);
  return result[1].meta.changes ? context.body(null, 204) : context.json({ error: "membership_conflict" }, 409);
});
permissionRoutes.get("/choirs/:choirId/permission-changes", async context => {
  const choirId = context.req.param("choirId");
  const actor = await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  if (!actor.isOwner) throw new AuthorizationError();
  const changes = await context.env.DB.prepare(`SELECT id, actor_name AS actorName, target_name AS targetName, before_json AS before, after_json AS after, created_at AS createdAt
    FROM permission_changes WHERE choir_id = ? ORDER BY created_at DESC, id LIMIT 100`).bind(choirId).all();
  return context.json({ changes: changes.results });
});
permissionRoutes.get("/choirs/:choirId/permission-layers", async context => {
  const choirId = context.req.param("choirId");
  await readPermissionMember(context.env.DB, await resolveContextPrincipal(context), choirId);
  const rows = await context.env.DB.prepare("SELECT slot, name FROM choir_shared_layer_settings WHERE choir_id = ? ORDER BY sort_order, slot").bind(choirId).all();
  return context.json({ layers: rows.results });
});
