import { Hono } from "hono";

import { healthResponseSchema } from "../src/shared/health";
import { AuthorizationError } from "./auth/authorization";
import { createAuth } from "./auth/create-auth";
import { choirRoutes } from "./choirs/routes";
import type { AppEnvironment } from "./env";
import { cleanupExpiredScoreVersions } from "./scores/cleanup";
import { scoreRoutes } from "./scores/routes";

const app = new Hono<AppEnvironment>();

app.get("/api/health", (context) => {
  return context.json(
    healthResponseSchema.parse({
      status: "ok",
      service: "same-page",
      runtime: "cloudflare-worker",
    }),
  );
});

app.on(["GET", "POST"], "/api/auth/*", (context) => {
  return createAuth(context.env, context.executionCtx).handler(context.req.raw);
});

app.route("/api", choirRoutes);
app.route("/api", scoreRoutes);

app.notFound((context) => context.json({ error: "not_found" }, 404));

app.onError((error, context) => {
  if (error instanceof AuthorizationError) {
    return context.json({ error: "forbidden" }, 403);
  }
  return context.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) {
    context.waitUntil(cleanupExpiredScoreVersions(env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
