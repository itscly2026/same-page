import type { Context } from "hono";
import { getCookie } from "hono/cookie";

import type { AppEnvironment } from "../env";
import { GUEST_SESSION_COOKIE } from "../security/guest-session";
import { resolveGuestPrincipal, resolvePrincipal } from "./principal";

export function resolveContextPrincipal(context: Context<AppEnvironment>) {
  return resolvePrincipal({
    request: context.req.raw,
    env: context.env,
    executionContext: context.executionCtx,
    guestToken: getCookie(context, GUEST_SESSION_COOKIE),
  });
}

export function resolveContextGuestPrincipal(context: Context<AppEnvironment>) {
  return resolveGuestPrincipal({
    env: context.env,
    guestToken: getCookie(context, GUEST_SESSION_COOKIE),
  });
}
