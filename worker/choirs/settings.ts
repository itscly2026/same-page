import { memberCapabilities } from "../permissions/access";
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { driveNameRequestSchema, memberDisplayNameRequestSchema } from "../../src/shared/choirs";
import { AuthorizationError, requireChoirRead } from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import { createDatabase } from "../db/database";
import { choirs, memberships } from "../db/schema";
import type { AppEnvironment } from "../env";

export const driveSettingsRoutes = new Hono<AppEnvironment>();
driveSettingsRoutes.get("/choirs/:choirId/settings", async context => {
  const database = createDatabase(context.env.DB);
  const choirId = context.req.param("choirId");
  const access = await requireChoirRead(database, await resolveContextPrincipal(context), choirId);
  if (access.kind !== "membership") throw new AuthorizationError();
  const choir = await database.query.choirs.findFirst({ where: eq(choirs.id, choirId) });
  return context.json({ name: choir!.name, nameRevision: choir!.nameRevision,
    displayName: access.membership.displayName, membershipRevision: access.membership.lifecycleRevision,
    canEditDriveInfo: memberCapabilities(access.membership).operations.operations.includes("editDriveInfo") });
});

driveSettingsRoutes.patch("/choirs/:choirId/display-name", async context => {
  const parsed = memberDisplayNameRequestSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "invalid_display_name" }, 400);
  const database = createDatabase(context.env.DB);
  const choirId = context.req.param("choirId");
  const principal = await resolveContextPrincipal(context);
  const access = await requireChoirRead(database, principal, choirId);
  if (access.kind !== "membership" || principal?.kind !== "user") throw new AuthorizationError();
  const changed = await database.update(memberships).set({ displayName: parsed.data.displayName,
    lifecycleRevision: sql`${memberships.lifecycleRevision} + 1` }).where(and(
    eq(memberships.id, access.membership.id), eq(memberships.userId, principal.userId), eq(memberships.status, "active"),
    eq(memberships.lifecycleRevision, parsed.data.expectedRevision),
  )).returning({ revision: memberships.lifecycleRevision });
  return changed.length ? context.json({ revision: changed[0].revision }) : context.json({ error: "revision_conflict" }, 409);
});

driveSettingsRoutes.patch("/choirs/:choirId/name", async context => {
  const parsed = driveNameRequestSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "invalid_drive_name" }, 400);
  const database = createDatabase(context.env.DB);
  const choirId = context.req.param("choirId");
  const principal = await resolveContextPrincipal(context);
  const access = await requireChoirRead(database, principal, choirId);
  if (access.kind !== "membership" || !memberCapabilities(access.membership).operations.operations.includes("editDriveInfo") || principal?.kind !== "user") throw new AuthorizationError();
  const changed = await database.update(choirs).set({ name: parsed.data.name, nameRevision: sql`${choirs.nameRevision} + 1` }).where(and(
    eq(choirs.id, choirId), eq(choirs.nameRevision, parsed.data.expectedRevision),
    sql`exists (select 1 from membership_capabilities m where m.choir_id = ${choirs.id} and m.user_id = ${principal.userId} and m.status = 'active' and m.editDriveInfo = 1)`,
  )).returning({ revision: choirs.nameRevision });
  return changed.length ? context.json({ revision: changed[0].revision }) : context.json({ error: "revision_conflict" }, 409);
});
