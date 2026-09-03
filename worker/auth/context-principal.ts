import type { Context } from "hono";
import { getCookie } from "hono/cookie";

import type { AppEnvironment } from "../env";
import { GUEST_SESSION_COOKIE } from "../security/guest-session";
import { measureServerTiming } from "../performance/server-timing";
import {
  resolveGuestPrincipal,
  resolvePrincipal,
  resolvePrincipalCandidates,
} from "./principal";

export function resolveContextPrincipal(context: Context<AppEnvironment>) {
  return measureServerTiming(context, "auth", () => resolvePrincipal({
    request: context.req.raw,
    env: context.env,
    executionContext: context.executionCtx,
    guestToken: getCookie(context, GUEST_SESSION_COOKIE),
  }));
}

export function resolveContextGuestPrincipal(context: Context<AppEnvironment>) {
  return measureServerTiming(context, "auth", () => resolveGuestPrincipal({
    env: context.env,
    guestToken: getCookie(context, GUEST_SESSION_COOKIE),
  }));
}

export function resolveContextPrincipalCandidates(context: Context<AppEnvironment>) {
  return measureServerTiming(context, "auth", () => resolvePrincipalCandidates({
    request: context.req.raw,
    env: context.env,
    executionContext: context.executionCtx,
    guestToken: getCookie(context, GUEST_SESSION_COOKIE),
  }));
}
