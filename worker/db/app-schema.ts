import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth-schema.generated";

export const choirs = sqliteTable(
  "choirs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    guestAdmissionMode: text("guest_admission_mode", {
      enum: ["invite", "open"],
    })
      .notNull()
      .default("invite"),
    guestSessionVersion: integer("guest_session_version").notNull().default(1),
    isPreviewEntry: integer("is_preview_entry", { mode: "boolean" })
      .notNull()
      .default(false),
    joinCodeHash: text("join_code_hash"),
    joinCodeCiphertext: text("join_code_ciphertext"),
    storageLimitBytes: integer("storage_limit_bytes")
      .notNull()
      .default(1_073_741_824),
    storageUsedBytes: integer("storage_used_bytes").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    uniqueIndex("choirs_join_code_hash_uidx").on(table.joinCodeHash),
    uniqueIndex("choirs_preview_entry_uidx")
      .on(table.isPreviewEntry)
      .where(sql`${table.isPreviewEntry} = 1`),
    check(
      "choirs_guest_admission_mode_valid",
      sql`${table.guestAdmissionMode} in ('invite', 'open')`,
    ),
    check(
      "choirs_guest_admission_mode_matches_join_code",
      sql`(${table.guestAdmissionMode} = 'invite' and ${table.joinCodeHash} is not null)
        or (${table.guestAdmissionMode} = 'open' and ${table.joinCodeHash} is null)`,
    ),
    check(
      "choirs_preview_entry_requires_open_admission",
      sql`${table.isPreviewEntry} = 0 or ${table.guestAdmissionMode} = 'open'`,
    ),
    check("choirs_storage_limit_positive", sql`${table.storageLimitBytes} > 0`),
    check("choirs_storage_used_nonnegative", sql`${table.storageUsedBytes} >= 0`),
  ],
);

export const scores = sqliteTable(
  "scores",
  {
    id: text("id").primaryKey(),
    choirId: text("choir_id")
      .notNull()
      .references(() => choirs.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    fileNameKey: text("file_name_key").notNull(),
    currentVersionId: text("current_version_id"),
    replacementLockId: text("replacement_lock_id"),
    replacementLockExpiresAt: integer("replacement_lock_expires_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    trashedAt: integer("trashed_at", { mode: "timestamp_ms" }),
    trashExpiresAt: integer("trash_expires_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("scores_active_filename_uidx")
      .on(table.choirId, table.fileNameKey)
      .where(sql`${table.trashedAt} is null`),
    index("scores_choir_filename_idx")
      .on(table.choirId, table.fileNameKey)
      .where(sql`${table.trashedAt} is null`),
    index("scores_trash_expiry_idx")
      .on(table.trashExpiresAt)
      .where(sql`${table.trashedAt} is not null`),
    check(
      "scores_trash_dates_valid",
      sql`(${table.trashedAt} is null and ${table.trashExpiresAt} is null)
        or (${table.trashedAt} is not null and ${table.trashExpiresAt} is not null
          and ${table.trashExpiresAt} > ${table.trashedAt})`,
    ),
  ],
);

export const scoreVersions = sqliteTable(
  "score_versions",
  {
    id: text("id").primaryKey(),
    choirId: text("choir_id")
      .notNull()
      .references(() => choirs.id, { onDelete: "cascade" }),
    scoreId: text("score_id")
      .notNull()
      .references(() => scores.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    etag: text("etag"),
    pageCount: integer("page_count").notNull(),
    state: text("state", { enum: ["pending", "ready"] })
      .notNull()
      .default("pending"),
    uploadedByMembershipId: text("uploaded_by_membership_id").references(
      () => memberships.id,
      { onDelete: "set null" },
    ),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    readyAt: integer("ready_at", { mode: "timestamp_ms" }),
    retentionExpiresAt: integer("retention_expires_at", {
      mode: "timestamp_ms",
    }),
  },
  (table) => [
    uniqueIndex("score_versions_score_number_uidx").on(
      table.scoreId,
      table.versionNumber,
    ),
    index("score_versions_retention_idx").on(
      table.state,
      table.retentionExpiresAt,
    ),
    index("score_versions_pending_idx").on(table.state, table.createdAt),
    check(
      "score_versions_size_valid",
      sql`${table.sizeBytes} > 0 and ${table.sizeBytes} <= 20971520`,
    ),
    check("score_versions_page_count_positive", sql`${table.pageCount} > 0`),
    check(
      "score_versions_state_valid",
      sql`${table.state} in ('pending', 'ready')`,
    ),
  ],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    choirId: text("choir_id")
      .notNull()
      .references(() => choirs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    status: text("status", { enum: ["active", "removed"] })
      .notNull()
      .default("active"),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    removedAt: integer("removed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("memberships_choir_user_uidx").on(
      table.choirId,
      table.userId,
    ),
    index("memberships_user_status_idx").on(table.userId, table.status),
    check("memberships_role_valid", sql`${table.role} in ('admin', 'member')`),
    check(
      "memberships_status_valid",
      sql`${table.status} in ('active', 'removed')`,
    ),
  ],
);

export const sharedLayerEditGrants = sqliteTable(
  "shared_layer_edit_grants",
  {
    id: text("id").primaryKey(),
    choirId: text("choir_id")
      .notNull()
      .references(() => choirs.id, { onDelete: "cascade" }),
    slot: text("slot", { enum: ["E", "S", "A", "T", "B"] }).notNull(),
    membershipId: text("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    uniqueIndex("shared_layer_edit_grants_slot_membership_uidx").on(
      table.choirId,
      table.slot,
      table.membershipId,
    ),
  ],
);

export const choirSharedLayerSettings = sqliteTable(
  "choir_shared_layer_settings",
  {
    choirId: text("choir_id")
      .notNull()
      .references(() => choirs.id, { onDelete: "cascade" }),
    slot: text("slot", { enum: ["E", "S", "A", "T", "B"] }).notNull(),
    defaultColor: text("default_color").notNull(),
    updatedByMembershipId: text("updated_by_membership_id").references(
      () => memberships.id,
      { onDelete: "set null" },
    ),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("choir_shared_layer_settings_uidx").on(table.choirId, table.slot)],
);

export const userDriveLayerPreferences = sqliteTable(
  "user_drive_layer_preferences",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    choirId: text("choir_id").notNull().references(() => choirs.id, { onDelete: "cascade" }),
    slot: text("slot", { enum: ["E", "S", "A", "T", "B"] }).notNull(),
    subscribed: integer("subscribed", { mode: "boolean" }).notNull().default(true),
    colorOverride: text("color_override"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("user_drive_layer_preferences_uidx").on(table.userId, table.choirId, table.slot)],
);

export const userScoreLayerPreferences = sqliteTable(
  "user_score_layer_preferences",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    choirId: text("choir_id").notNull().references(() => choirs.id, { onDelete: "cascade" }),
    scoreId: text("score_id").notNull().references(() => scores.id, { onDelete: "cascade" }),
    slot: text("slot", { enum: ["E", "S", "A", "T", "B"] }).notNull(),
    subscribedOverride: integer("subscribed_override", { mode: "boolean" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("user_score_layer_preferences_uidx").on(table.userId, table.scoreId, table.slot)],
);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowExpiresAt: integer("window_expires_at").notNull(),
});

export const scoreObjectDeletions = sqliteTable("score_object_deletions", {
  id: text("id").primaryKey(),
  objectKey: text("object_key").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
});

export const annotationLayers = sqliteTable(
  "annotation_layers",
  {
    id: text("id").primaryKey(),
    choirId: text("choir_id").notNull(),
    scoreId: text("score_id").notNull(),
    kind: text("kind", { enum: ["shared", "personal"] }).notNull(),
    ownerUserId: text("owner_user_id"),
    defaultSlot: text("default_slot", { enum: ["E", "S", "A", "T", "B"] }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    defaultColor: text("default_color").notNull(),
    createdByMembershipId: text("created_by_membership_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("annotation_layers_score_sort_idx").on(
      table.scoreId,
      table.kind,
      table.sortOrder,
      table.createdAt,
    ),
    uniqueIndex("annotation_layers_default_slot_uidx")
      .on(table.scoreId, table.defaultSlot)
      .where(sql`${table.defaultSlot} is not null`),
    check(
      "annotation_layers_fixed_kind_valid",
      sql`(${table.kind} = 'shared' and ${table.ownerUserId} is null and ${table.defaultSlot} is not null)
        or (${table.kind} = 'personal' and ${table.ownerUserId} is not null and ${table.defaultSlot} is null)`,
    ),
  ],
);

export const annotationObjects = sqliteTable(
  "annotation_objects",
  {
    id: text("id").primaryKey(),
    choirId: text("choir_id").notNull(),
    scoreId: text("score_id").notNull(),
    layerId: text("layer_id").notNull(),
    version: integer("version").notNull(),
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    payloadJson: text("payload_json"),
    createdByUserId: text("created_by_user_id"),
    createdByDisplayName: text("created_by_display_name").notNull(),
    updatedByUserId: text("updated_by_user_id"),
    updatedByDisplayName: text("updated_by_display_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("annotation_objects_score_layer_idx").on(
      table.scoreId,
      table.layerId,
      table.deleted,
      table.updatedAt,
    ),
  ],
);
