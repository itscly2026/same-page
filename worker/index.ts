import { Hono } from "hono";

import { buildId } from "../src/shared/build";
import { healthResponseSchema } from "../src/shared/health";
import { annotationRoutes } from "./annotations/routes";
import { AuthorizationError } from "./auth/authorization";
import { handleAuthRequest } from "./auth/handler";
import { choirRoutes } from "./choirs/routes";
import type { AppEnvironment } from "./env";
import { serverTimingMiddleware } from "./performance/server-timing";
import { cleanupScoreStorage } from "./scores/cleanup";
import { scoreRoutes } from "./scores/routes";

const app = new Hono<AppEnvironment>();

app.use("/api/*", serverTimingMiddleware);

app.get("/api/health", (context) => {
  return context.json(
    healthResponseSchema.parse({
      status: "ok",
      service: "same-page",
      runtime: "cloudflare-worker",
      buildId,
    }),
  );
});

app.on(["GET", "POST"], "/api/auth/*", handleAuthRequest);

app.route("/api", choirRoutes);
app.route("/api", scoreRoutes);
app.route("/api", annotationRoutes);

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
    context.waitUntil(cleanupScoreStorage(env));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
