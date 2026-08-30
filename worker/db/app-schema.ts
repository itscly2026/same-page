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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    uniqueIndex("choirs_join_code_hash_uidx").on(table.joinCodeHash),
    check("choirs_storage_limit_positive", sql`${table.storageLimitBytes} > 0`),
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
