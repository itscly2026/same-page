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
    joinCodeHash: text("join_code_hash").notNull(),
    joinCodeVersion: integer("join_code_version").notNull().default(1),
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
    title: text("title").notNull(),
    composer: text("composer"),
    arranger: text("arranger"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["draft", "published", "archived"] })
      .notNull()
      .default("draft"),
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
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("scores_choir_status_sort_idx").on(
      table.choirId,
      table.status,
      table.sortOrder,
      table.title,
    ),
    check(
      "scores_status_valid",
      sql`${table.status} in ('draft', 'published', 'archived')`,
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
    sharedLayerId: text("shared_layer_id").notNull(),
    membershipId: text("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    uniqueIndex("shared_layer_edit_grants_layer_membership_uidx").on(
      table.choirId,
      table.sharedLayerId,
      table.membershipId,
    ),
  ],
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
