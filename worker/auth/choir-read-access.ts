import type { Context } from "hono";

import type { AppEnvironment } from "../env";
import { createDatabase } from "../db/database";
import { AuthorizationError, requireChoirRead } from "./authorization";
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
        access: await requireChoirRead(database, userOrGuest, choirId),
      };
    } catch (error) {
      if (!(error instanceof AuthorizationError) || userOrGuest.kind !== "user") {
        throw error;
      }
    }
  }

  const guest = await resolveContextGuestPrincipal(context);
  return {
    principal: guest,
    access: await requireChoirRead(database, guest, choirId),
  };
}
