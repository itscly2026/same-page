import type { MiddlewareHandler } from "hono";
import type { AppEnvironment } from "../env";

// Fence score, image, version, annotation and drive routes before dispatch.
// Drive bootstrap folds the same tombstone check into its single-snapshot SQL;
// all other routes (including score bootstrap) pass through this guard.
export const excludeDeletedResources: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  const match = /^\/api\/(?:guest\/)?choirs\/([^/]+)(?:\/scores\/([^/]+)(?:\/versions\/([^/]+))?)?/.exec(context.req.path);
  if (match && !/^\/api\/choirs\/[^/]+\/bootstrap$/.test(context.req.path)) {
    const [driveId, scoreId, versionId] = match.slice(1).map(value => value ? decodeURIComponent(value) : "");
    const deleted = await context.env.DB.prepare(`SELECT 1 FROM choirs WHERE id = ? AND purged_at IS NOT NULL
      UNION ALL SELECT 1 FROM scores WHERE id = ? AND choir_id = ? AND purged_at IS NOT NULL
      UNION ALL SELECT 1 FROM score_versions WHERE id = ? AND score_id = ? AND choir_id = ? AND purged_at IS NOT NULL LIMIT 1`)
      .bind(driveId, scoreId, driveId, versionId, scoreId, driveId).first();
    if (deleted) return context.json({ error: "resource_deleted" }, 404);
  }
  await next();
};
