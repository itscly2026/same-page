import type { Context } from "hono";

import type { AppEnvironment } from "../env";
import { createDatabase } from "../db/database";
import { AuthorizationError, requireChoirRead } from "./authorization";
import { measureServerTiming } from "../performance/server-timing";
import {
  resolveContextGuestPrincipal,
  resolveContextPrincipal,
} from "./context-principal";

export async function resolveContextChoirReadAccess(
  context: Context<AppEnvironment>,
  choirId: string,
) {
  const database = createDatabase(context.env.DB);
  const userOrGuest = await resolveContextPrincipal(context);
  if (userOrGuest) {
    try {
      return {
        principal: userOrGuest,
        access: await measureServerTiming(context, "access", () =>
          requireChoirRead(database, userOrGuest, choirId)),
      };
    } catch (error) {
      if (userOrGuest.kind === "user" && await context.env.DB.prepare(
        "SELECT id FROM memberships WHERE choir_id = ? AND user_id = ? AND status = 'removed'",
      ).bind(choirId, userOrGuest.userId).first()) throw error;
      if (!(error instanceof AuthorizationError) || userOrGuest.kind !== "user") {
        throw error;
      }
    }
  }

  const guest = await resolveContextGuestPrincipal(context);
  return {
    principal: guest,
    access: await measureServerTiming(context, "access", () =>
      requireChoirRead(database, guest, choirId)),
  };
}
