import { androidReleaseRoutes } from "./android-release";
import { trialRoutes } from "./choirs/trial-routes";
import { excludeDeletedResources } from "./choirs/deleted-access";
import { permissionRoutes } from "./permissions/routes";
import { cleanupAnnotationLayers } from "./annotations/cleanup";
import { driveSettingsRoutes } from "./choirs/settings";
import { cleanupLifecycles } from "./lifecycle/cleanup";
import { lifecycleRoutes } from "./lifecycle/routes";
import { Hono } from "hono";

import { buildId } from "../src/shared/build";
import { healthResponseSchema } from "../src/shared/health";
import { annotationRoutes } from "./annotations/routes";
import { AuthorizationError } from "./auth/authorization";
import { handleAuthRequest } from "./auth/handler";
import { choirRoutes } from "./choirs/routes";
import type { AppEnvironment } from "./env";
import { diagnosticReportRoutes, cleanupDiagnosticReports } from "./diagnostic-reports";
import { diagnosticMiddleware, logFailure } from "./diagnostics";
import { serverTimingMiddleware } from "./performance/server-timing";
import { cleanupScoreStorage } from "./scores/cleanup";
import { scoreRoutes } from "./scores/routes";
import { cleanupRateLimits } from "./security/rate-limit";

const app = new Hono<AppEnvironment>();

app.use("/api/*", diagnosticMiddleware, serverTimingMiddleware);
app.use("/api/*", async (context, next) => {
  const origin = context.req.header("Origin");
  if (!context.req.path.startsWith("/api/auth/") && !["GET", "HEAD", "OPTIONS"].includes(context.req.method) && origin && origin !== new URL(context.env.BETTER_AUTH_URL).origin) {
    return context.json({ error: "forbidden" }, 403);
  }
  await next();
});

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

app.route("/api", androidReleaseRoutes);

app.use("/api/*", excludeDeletedResources);
app.route("/api", trialRoutes);
app.route("/api", diagnosticReportRoutes);
app.route("/api", permissionRoutes);
app.route("/api", lifecycleRoutes);
app.route("/api", choirRoutes);
app.route("/api", driveSettingsRoutes);
app.route("/api", scoreRoutes);
app.route("/api", annotationRoutes);

app.notFound((context) => context.json({ error: "not_found" }, 404));

app.onError((error, context) => {
  if (error instanceof Error) {
    const messages: string[] = [];
    let cause: unknown = error;
    for (let depth = 0; cause instanceof Error && depth < 5; depth++, cause = cause.cause) messages.push(cause.message);
    const code = ["platform_storage_limit_reached", "free_drive_limit_reached", "owned_drive_limit_reached", "member_limit_reached", "score_limit_reached", "resource_deleted"].find(code => messages.some(message => message.includes(code)));
    if (code) return context.json({ error: code }, 409);
  }
  if (error instanceof Error && error.message.includes("owner_requires_transfer")) {
    return context.json({ error: "owner_requires_transfer" }, 409);
  }
  if (error instanceof Error && /annotation_permission_revoked|upload_permission_revoked/.test(error.message)) return context.json({ error: "forbidden" }, 403);
  if (error instanceof AuthorizationError) {
    return context.json({ error: "forbidden" }, 403);
  }
  return context.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(_controller, env, context) {
    context.waitUntil(cleanupAnnotationLayers(env.DB).catch(() => {
      logFailure("storage", "cleanup", 500, crypto.randomUUID());
      throw new Error("annotation_layer_cleanup_failed");
    }));
    context.waitUntil(cleanupDiagnosticReports(env.DB).catch(() => {
      logFailure("storage", "cleanup", 500, crypto.randomUUID());
      throw new Error("diagnostic_report_cleanup_failed");
    }));
    context.waitUntil(cleanupScoreStorage(env).catch(() => {
      logFailure("storage", "cleanup", 500, crypto.randomUUID());
      throw new Error("score_storage_cleanup_failed");
    }));
    context.waitUntil(cleanupLifecycles(env).catch(() => {
      logFailure("auth", "cleanup", 500, crypto.randomUUID());
      throw new Error("user_lifecycle_cleanup_failed");
    }));
    context.waitUntil(cleanupRateLimits(env.DB).catch(() => {
      logFailure("auth", "cleanup", 500, crypto.randomUUID());
      throw new Error("rate_limit_cleanup_failed");
    }));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
