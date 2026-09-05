import { AnnotationScopeAccessError, synchronizeOperations } from "./synchronize";
import { type Context, Hono } from "hono";

import {
  annotationPayloadSchema,
  annotationPushRequestSchema,
  defaultSharedLayerSlotSchema,
  defaultSharedLayers,
  driveLayerPreferenceUpdateSchema,
  resolveSharedLayerPreference,
  scoreLayerPreferenceUpdateSchema,
  sharedLayerSettingUpdateSchema,
  type AnnotationObjectRecord,
} from "../../src/shared/annotations";
import {
  AuthorizationError,
  requireChoirAdmin,
  requireChoirRead,
} from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import { resolveContextChoirReadAccess } from "../auth/choir-read-access";
import type { Principal } from "../auth/principal";
import { createDatabase } from "../db/database";
import type { AppEnvironment } from "../env";

export const annotationRoutes = new Hono<AppEnvironment>();

annotationRoutes.get("/choirs/:choirId/scores/:scoreId/layers", async (context) => {
  const access = await resolveScoreAccess(context);
  if (access instanceof Response) return access;
  const { choirId, scoreId, principal } = access;
  const userId = principal.kind === "user" ? principal.userId : null;

  if (userId) {
    const now = Date.now();
    await context.env.DB.prepare(
      `INSERT OR IGNORE INTO annotation_layers
         (id, choir_id, score_id, kind, owner_user_id, name, sort_order,
          default_color, created_by_membership_id, created_at, updated_at)
       VALUES (?, ?, ?, 'personal', ?, 'Personal', 10000, '#b4235a', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), choirId, scoreId, userId, access.membership?.id ?? null, now, now).run();
  }

  const rows = await context.env.DB.prepare(
    `SELECT layers.id, layers.kind, layers.default_slot, layers.name, layers.sort_order,
            layers.default_color AS product_default_color,
            settings.default_color AS admin_default_color,
            drive_preferences.subscribed AS drive_subscribed,
            drive_preferences.color_override AS drive_color_override,
            score_preferences.subscribed_override AS score_subscribed_override,
            CASE
              WHEN layers.kind = 'personal' AND layers.owner_user_id = ? THEN 1
              WHEN ? = 1 THEN 1
              WHEN grants.id IS NOT NULL THEN 1
              ELSE 0
            END AS can_edit
     FROM annotation_layers AS layers
     LEFT JOIN choir_shared_layer_settings AS settings
       ON settings.choir_id = layers.choir_id AND settings.slot = layers.default_slot
     LEFT JOIN user_drive_layer_preferences AS drive_preferences
       ON drive_preferences.user_id = ? AND drive_preferences.choir_id = layers.choir_id
      AND drive_preferences.slot = layers.default_slot
     LEFT JOIN user_score_layer_preferences AS score_preferences
       ON score_preferences.user_id = ? AND score_preferences.score_id = layers.score_id
      AND score_preferences.slot = layers.default_slot
     LEFT JOIN shared_layer_edit_grants AS grants
       ON grants.slot = layers.default_slot
      AND grants.membership_id = ?
      AND grants.choir_id = layers.choir_id
     WHERE layers.choir_id = ? AND layers.score_id = ?
       AND (layers.kind = 'shared' OR layers.owner_user_id = ?)
     ORDER BY CASE layers.kind WHEN 'shared' THEN 0 ELSE 1 END,
              layers.sort_order, layers.created_at`,
  ).bind(userId, access.membership?.role === "admin" ? 1 : 0, userId, userId,
    access.membership?.id ?? null, choirId, scoreId, userId).all<LayerRow>();

  return context.json({
    layers: rows.results.map(serializeLayer),
    permissions: { canManageLayers: access.membership?.role === "admin" },
  });
});

annotationRoutes.get("/choirs/:choirId/shared-layer-preferences", async (context) => {
  const choirId = context.req.param("choirId");
  const principal = await resolveContextPrincipal(context);
  await requireChoirRead(createDatabase(context.env.DB), principal, choirId);
  if (principal?.kind !== "user") {
    return context.json({ error: "guest_preferences_are_local" }, 403);
  }

  const drive = await readDriveIdentity(context, choirId);
  if (!drive) return context.json({ error: "choir_not_found" }, 404);
  const rows = await context.env.DB.prepare(
    `SELECT settings.slot, settings.default_color AS admin_default_color,
            preferences.subscribed, preferences.color_override
     FROM choir_shared_layer_settings AS settings
     LEFT JOIN user_drive_layer_preferences AS preferences
       ON preferences.choir_id = settings.choir_id
      AND preferences.slot = settings.slot
      AND preferences.user_id = ?
     WHERE settings.choir_id = ?`,
  ).bind(principal.userId, choirId).all<{
    slot: "E" | "S" | "A" | "T" | "B";
    admin_default_color: string;
    subscribed: number | null;
    color_override: string | null;
  }>();
  const bySlot = new Map(rows.results.map((row) => [row.slot, row]));

  return context.json({
    drive,
    layers: defaultSharedLayers.map((layer) => {
      const row = bySlot.get(layer.slot);
      const adminDefaultColor = row?.admin_default_color ?? layer.defaultColor;
      const colorOverride = row?.color_override ?? null;
      return {
        slot: layer.slot,
        name: layer.name,
        subscribed: row?.subscribed !== 0,
        colorOverride,
        adminDefaultColor,
        displayColor: colorOverride ?? adminDefaultColor ?? layer.defaultColor,
        colorSource: colorOverride
          ? "drive" as const
          : row?.admin_default_color
            ? "admin" as const
            : "product" as const,
      };
    }),
  });
});

annotationRoutes.get("/choirs/:choirId/shared-layers", async (context) => {
  const choirId = context.req.param("choirId");
  const principal = await resolveContextPrincipal(context);
  await requireChoirAdmin(createDatabase(context.env.DB), principal, choirId);
  const drive = await readDriveIdentity(context, choirId);
  if (!drive) return context.json({ error: "choir_not_found" }, 404);
  const rows = await context.env.DB.prepare(
    `SELECT settings.slot, settings.default_color,
            COUNT(granted_members.id) AS granted_member_count
     FROM choir_shared_layer_settings AS settings
     LEFT JOIN shared_layer_edit_grants AS grants
       ON grants.choir_id = settings.choir_id AND grants.slot = settings.slot
     LEFT JOIN memberships AS granted_members
       ON granted_members.id = grants.membership_id
      AND granted_members.choir_id = settings.choir_id
      AND granted_members.status = 'active'
      AND granted_members.role = 'member'
     WHERE settings.choir_id = ?
     GROUP BY settings.slot, settings.default_color`,
  ).bind(choirId).all<{
    slot: "E" | "S" | "A" | "T" | "B";
    default_color: string;
    granted_member_count: number;
  }>();
  const bySlot = new Map(rows.results.map((row) => [row.slot, row]));

  return context.json({
    drive,
    layers: defaultSharedLayers.map((layer) => ({
      slot: layer.slot,
      name: layer.name,
      defaultColor: bySlot.get(layer.slot)?.default_color ?? layer.defaultColor,
      grantedMemberCount: Number(bySlot.get(layer.slot)?.granted_member_count ?? 0),
    })),
  });
});

annotationRoutes.put("/choirs/:choirId/shared-layers/:slot/settings", async (context) => {
  const choirId = context.req.param("choirId");
  const slot = defaultSharedLayerSlotSchema.safeParse(context.req.param("slot"));
  const principal = await resolveContextPrincipal(context);
  const membership = await requireChoirAdmin(createDatabase(context.env.DB), principal, choirId);
  const parsed = sharedLayerSettingUpdateSchema.safeParse(await context.req.json().catch(() => null));
  if (!slot.success || !parsed.success) return context.json({ error: "invalid_layer_setting" }, 400);
  const defaultColor = parsed.data.defaultColor.toLowerCase();
  await context.env.DB.prepare(
    `INSERT INTO choir_shared_layer_settings
       (choir_id, slot, default_color, updated_by_membership_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(choir_id, slot) DO UPDATE SET
       default_color = excluded.default_color,
       updated_by_membership_id = excluded.updated_by_membership_id,
       updated_at = excluded.updated_at`,
  ).bind(choirId, slot.data, defaultColor, membership.id, Date.now()).run();
  return context.json({ setting: { slot: slot.data, defaultColor } });
});

annotationRoutes.put("/choirs/:choirId/shared-layers/:slot/preference", async (context) => {
  const choirId = context.req.param("choirId");
  const slot = defaultSharedLayerSlotSchema.safeParse(context.req.param("slot"));
  const principal = await resolveContextPrincipal(context);
  await requireChoirRead(createDatabase(context.env.DB), principal, choirId);
  if (principal?.kind !== "user") return context.json({ error: "guest_preferences_are_local" }, 403);
  const parsed = driveLayerPreferenceUpdateSchema.safeParse(await context.req.json().catch(() => null));
  if (!slot.success || !parsed.success || Object.keys(parsed.data).length === 0) {
    return context.json({ error: "invalid_preference" }, 400);
  }
  const existing = await context.env.DB.prepare(
    "SELECT subscribed, color_override FROM user_drive_layer_preferences WHERE user_id = ? AND choir_id = ? AND slot = ?",
  ).bind(principal.userId, choirId, slot.data).first<{ subscribed: number; color_override: string | null }>();
  const subscribed = parsed.data.subscribed ?? existing?.subscribed !== 0;
  const colorOverride = parsed.data.colorOverride === undefined
    ? existing?.color_override ?? null
    : parsed.data.colorOverride?.toLowerCase() ?? null;
  await context.env.DB.prepare(
    `INSERT INTO user_drive_layer_preferences
       (user_id, choir_id, slot, subscribed, color_override, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, choir_id, slot) DO UPDATE SET
       subscribed = excluded.subscribed,
       color_override = excluded.color_override,
       updated_at = excluded.updated_at`,
  ).bind(principal.userId, choirId, slot.data, subscribed ? 1 : 0, colorOverride, Date.now()).run();
  return context.json({ preference: { subscribed, colorOverride } });
});

annotationRoutes.put("/choirs/:choirId/scores/:scoreId/shared-layers/:slot/preference", async (context) => {
  const access = await resolveScoreAccess(context);
  if (access instanceof Response) return access;
  const slot = defaultSharedLayerSlotSchema.safeParse(context.req.param("slot"));
  if (access.principal.kind !== "user") return context.json({ error: "guest_preferences_are_local" }, 403);
  const parsed = scoreLayerPreferenceUpdateSchema.safeParse(await context.req.json().catch(() => null));
  if (!slot.success || !parsed.success || Object.keys(parsed.data).length === 0) {
    return context.json({ error: "invalid_preference" }, 400);
  }
  const existing = await context.env.DB.prepare(
    "SELECT subscribed_override FROM user_score_layer_preferences WHERE user_id = ? AND score_id = ? AND slot = ?",
  ).bind(access.principal.userId, access.scoreId, slot.data).first<{
    subscribed_override: number | null;
  }>();
  const subscribed = parsed.data.subscribed === undefined
    ? existing?.subscribed_override == null ? null : existing.subscribed_override === 1
    : parsed.data.subscribed;
  await context.env.DB.prepare(
    `INSERT INTO user_score_layer_preferences
       (user_id, choir_id, score_id, slot, subscribed_override, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, score_id, slot) DO UPDATE SET
       subscribed_override = excluded.subscribed_override,
       updated_at = excluded.updated_at`,
  ).bind(access.principal.userId, access.choirId, access.scoreId, slot.data,
    subscribed === null ? null : subscribed ? 1 : 0, Date.now()).run();
  return context.json({ preference: { subscribed } });
});

annotationRoutes.get("/choirs/:choirId/shared-layers/:slot/grants", async (context) => {
  const choirId = context.req.param("choirId");
  const slot = defaultSharedLayerSlotSchema.safeParse(context.req.param("slot"));
  const principal = await resolveContextPrincipal(context);
  await requireChoirAdmin(createDatabase(context.env.DB), principal, choirId);
  if (!slot.success) return context.json({ error: "invalid_slot" }, 400);
  const members = await context.env.DB.prepare(
    `SELECT memberships.id, memberships.display_name, memberships.role,
            CASE WHEN grants.id IS NULL THEN 0 ELSE 1 END AS granted
     FROM memberships
     LEFT JOIN shared_layer_edit_grants AS grants
       ON grants.membership_id = memberships.id
      AND grants.slot = ?
      AND grants.choir_id = memberships.choir_id
     WHERE memberships.choir_id = ? AND memberships.status = 'active'
     ORDER BY memberships.role, memberships.display_name COLLATE NOCASE`,
  ).bind(slot.data, choirId).all<{ id: string; display_name: string; role: "admin" | "member"; granted: number }>();
  return context.json({ members: members.results.map((member) => ({
    id: member.id, displayName: member.display_name, role: member.role,
    granted: member.role === "admin" || member.granted === 1,
  })) });
});

annotationRoutes.put("/choirs/:choirId/shared-layers/:slot/grants/:membershipId", async (context) => {
  const choirId = context.req.param("choirId");
  const slot = defaultSharedLayerSlotSchema.safeParse(context.req.param("slot"));
  const membershipId = context.req.param("membershipId");
  const principal = await resolveContextPrincipal(context);
  await requireChoirAdmin(createDatabase(context.env.DB), principal, choirId);
  const body = (await context.req.json().catch(() => null)) as { granted?: unknown } | null;
  if (!slot.success || typeof body?.granted !== "boolean") return context.json({ error: "invalid_grant" }, 400);
  const actorId = principal?.kind === "user" ? principal.userId : "";
  const target = await context.env.DB.prepare(
    `SELECT target.role, target.lifecycle_revision AS target_revision, actor.lifecycle_revision AS actor_revision
     FROM memberships target JOIN memberships actor ON actor.choir_id = target.choir_id
     WHERE target.id = ? AND target.choir_id = ? AND target.status = 'active'
       AND actor.user_id = ? AND actor.status = 'active' AND actor.role = 'admin'`,
  ).bind(membershipId, choirId, actorId).first<{ role: string; target_revision: number; actor_revision: number }>();
  if (!target) return context.json({ error: "membership_not_found" }, 404);
  if (target.role === "admin") return context.json({ grant: { membershipId, granted: true } });
  const guard = `EXISTS (SELECT 1 FROM memberships target JOIN memberships actor ON actor.choir_id = target.choir_id
    WHERE target.id = ? AND target.choir_id = ? AND target.status = 'active' AND target.role = 'member' AND target.lifecycle_revision = ?
      AND actor.user_id = ? AND actor.status = 'active' AND actor.role = 'admin' AND actor.lifecycle_revision = ?)`;
  const guardBindings = [membershipId, choirId, target.target_revision, actorId, target.actor_revision];
  const mutation = body.granted
    ? context.env.DB.prepare(`INSERT INTO shared_layer_edit_grants (id, choir_id, slot, membership_id)
        SELECT ?, ?, ?, ? WHERE ${guard}
        ON CONFLICT(choir_id, slot, membership_id) DO UPDATE SET id = shared_layer_edit_grants.id`)
        .bind(crypto.randomUUID(), choirId, slot.data, membershipId, ...guardBindings)
    : context.env.DB.prepare(`DELETE FROM shared_layer_edit_grants WHERE choir_id = ? AND slot = ? AND membership_id = ? AND ${guard}`)
        .bind(choirId, slot.data, membershipId, ...guardBindings);
  const results = await context.env.DB.batch<{ valid: number }>([mutation, context.env.DB.prepare(`SELECT ${guard} AS valid`).bind(...guardBindings)]);
  if (!results[1]?.results[0]?.valid) return context.json({ error: "membership_changed" }, 409);
  return context.json({ grant: { membershipId, granted: body.granted } });
});

annotationRoutes.post("/choirs/:choirId/scores/:scoreId/annotations/push", async (context) => {
  const access = await resolveScoreAccess(context);
  if (access instanceof Response) return access;
  if (access.principal.kind !== "user") {
    return context.json({ error: "authentication_required" }, 401);
  }
  if (
    context.req.header("x-same-page-owner-user-id") !==
    access.principal.userId
  ) {
    return context.json({ error: "local_workspace_owner_changed" }, 409);
  }
  const parsed = annotationPushRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) return context.json({ error: "invalid_operations" }, 400);

  try {
    const results = await synchronizeOperations(context.env.DB, {
      choirId: access.choirId, scoreId: access.scoreId, userId: access.principal.userId,
    }, parsed.data.operations);
    return context.json({ results });
  } catch (error) {
    if (error instanceof AnnotationScopeAccessError) return context.json({ error: error.message }, error.status);
    throw error;
  }
});

annotationRoutes.get("/choirs/:choirId/scores/:scoreId/annotations", async (context) => {
  const access = await resolveScoreAccess(context);
  if (access instanceof Response) return access;
  const cursor = Math.max(0, Number.parseInt(context.req.query("cursor") ?? "0", 10) || 0);
  const userId = access.principal.kind === "user" ? access.principal.userId : null;
  const canViewAllAttribution = access.membership?.role === "admin";
  const rows = await context.env.DB.prepare(
    `SELECT operations.sequence, objects.id, objects.layer_id, objects.version,
            objects.deleted, objects.payload_json,
            CASE
              WHEN ? = 1 OR layers.owner_user_id = ? OR grants.id IS NOT NULL
              THEN objects.created_by_display_name ELSE ''
            END AS created_by_display_name,
            CASE
              WHEN ? = 1 OR layers.owner_user_id = ? OR grants.id IS NOT NULL
              THEN objects.updated_by_display_name ELSE ''
            END AS updated_by_display_name,
            objects.updated_at
     FROM annotation_sync_operations AS operations
     INNER JOIN annotation_layers AS layers ON layers.id = operations.layer_id
     INNER JOIN annotation_objects AS objects ON objects.id = operations.annotation_id
     LEFT JOIN shared_layer_edit_grants AS grants
       ON grants.slot = layers.default_slot
      AND grants.membership_id = ?
      AND grants.choir_id = layers.choir_id
     WHERE operations.score_id = ? AND operations.choir_id = ?
       AND operations.status = 'accepted' AND operations.sequence > ?
       AND (layers.kind = 'shared' OR layers.owner_user_id = ?)
     ORDER BY operations.sequence ASC
     LIMIT 500`,
  )
    .bind(
      canViewAllAttribution ? 1 : 0,
      userId,
      canViewAllAttribution ? 1 : 0,
      userId,
      access.membership?.id ?? null,
      access.scoreId,
      access.choirId,
      cursor,
      userId,
    )
    .all<PullRow>();
  const latestById = new Map<string, AnnotationObjectRecord>();
  let nextCursor = cursor;
  for (const row of rows.results) {
    nextCursor = Math.max(nextCursor, row.sequence);
    latestById.set(row.id, serializeObject(row));
  }
  return context.json({ cursor: nextCursor, objects: [...latestById.values()] });
});

async function resolveScoreAccess(
  context: Context<AppEnvironment>,
): Promise<ResolvedScoreAccess | Response> {
  const choirId = context.req.param("choirId") ?? "";
  const scoreId = context.req.param("scoreId") ?? "";
  let resolved;
  try { resolved = await resolveContextChoirReadAccess(context, choirId); }
  catch (error) {
    if (error instanceof AuthorizationError && !(await resolveContextPrincipal(context))) {
      return context.json({ error: "authentication_required" }, 401);
    }
    throw error;
  }
  const { principal, access } = resolved;
  if (!principal) return context.json({ error: "forbidden" }, 403);
  const score = await context.env.DB.prepare(
    "SELECT trashed_at FROM scores WHERE id = ? AND choir_id = ?",
  )
    .bind(scoreId, choirId)
    .first<{ trashed_at: number | null }>();
  if (!score || score.trashed_at !== null) {
    return context.json({ error: "score_not_found" }, 404);
  }
  return {
    choirId,
    scoreId,
    principal,
    membership: access.kind === "membership" ? access.membership : null,
  };
}

async function readDriveIdentity(context: Context<AppEnvironment>, choirId: string) {
  return context.env.DB.prepare("SELECT id, name FROM choirs WHERE id = ?")
    .bind(choirId)
    .first<{ id: string; name: string }>();
}

function serializeLayer(row: LayerRow) {
  if (row.kind === "personal") {
    return {
      id: row.id,
      kind: row.kind,
      defaultSlot: null,
      name: row.name,
      sortOrder: row.sort_order,
      subscribed: true,
      subscriptionSource: "personal" as const,
      displayColor: row.product_default_color,
      colorSource: "personal" as const,
      adminDefaultColor: null,
      driveSubscribed: null,
      driveColorOverride: null,
      scoreSubscriptionOverride: null,
      canEdit: row.can_edit === 1,
    };
  }
  const productDefaultColor = defaultSharedLayers.find(
    (layer) => layer.slot === row.default_slot,
  )?.defaultColor ?? row.product_default_color;
  const resolved = resolveSharedLayerPreference({
    productDefaultColor,
    adminDefaultColor: row.admin_default_color,
    driveSubscribed: row.drive_subscribed === null ? null : row.drive_subscribed === 1,
    driveColorOverride: row.drive_color_override,
    scoreSubscriptionOverride:
      row.score_subscribed_override === null ? null : row.score_subscribed_override === 1,
  });
  return {
    id: row.id,
    kind: row.kind,
    defaultSlot: row.default_slot,
    name: row.name,
    sortOrder: row.sort_order,
    ...resolved,
    adminDefaultColor: row.admin_default_color,
    driveSubscribed: row.drive_subscribed === null ? null : row.drive_subscribed === 1,
    driveColorOverride: row.drive_color_override,
    scoreSubscriptionOverride:
      row.score_subscribed_override === null ? null : row.score_subscribed_override === 1,
    canEdit: row.can_edit === 1,
  };
}

function serializeObject(row: ObjectRow): AnnotationObjectRecord {
  return {
    id: row.id,
    layerId: row.layer_id,
    version: row.version,
    deleted: row.deleted === 1,
    payload: row.payload_json
      ? annotationPayloadSchema.parse(JSON.parse(row.payload_json))
      : null,
    createdByDisplayName: row.created_by_display_name,
    updatedByDisplayName: row.updated_by_display_name,
    updatedAt: row.updated_at,
  };
}

interface ResolvedScoreAccess {
  choirId: string;
  scoreId: string;
  principal: Principal;
  membership: { id: string; role: "admin" | "member"; displayName: string } | null;
}

interface LayerRow {
  id: string;
  kind: "shared" | "personal";
  default_slot: "E" | "S" | "A" | "T" | "B" | null;
  name: string;
  sort_order: number;
  product_default_color: string;
  admin_default_color: string | null;
  drive_subscribed: number | null;
  drive_color_override: string | null;
  score_subscribed_override: number | null;
  can_edit: number;
}

interface ObjectRow {
  id: string;
  layer_id: string;
  version: number;
  deleted: number;
  payload_json: string | null;
  created_by_display_name: string;
  updated_by_display_name: string;
  updated_at: number;
}

interface PullRow extends ObjectRow {
  sequence: number;
}
