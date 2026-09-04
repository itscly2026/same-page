import { Hono } from "hono";
import { versionPublicationRequestSchema } from "../../src/shared/scores";
import { requireChoirAdmin } from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import { createDatabase } from "../db/database";
import type { AppEnvironment } from "../env";

export const versionRoutes = new Hono<AppEnvironment>();
const path = "/choirs/:choirId/scores/:scoreId/versions";

versionRoutes.get(path, async (context) => {
  const { choirId, scoreId } = context.req.param();
  await requireChoirAdmin(createDatabase(context.env.DB), await resolveContextPrincipal(context), choirId);
  const score = await context.env.DB.prepare(
    `SELECT current_version_id AS currentVersionId, version_revision AS revision
     FROM scores WHERE id = ? AND choir_id = ? AND trashed_at IS NULL`,
  ).bind(scoreId, choirId).first();
  if (!score) return context.json({ error: "score_not_found" }, 404);
  const versions = await context.env.DB.prepare(
    `SELECT id, version_number AS versionNumber, size_bytes AS sizeBytes, sha256, etag,
       page_count AS pageCount, created_at AS createdAt, retention_expires_at AS retentionExpiresAt
     FROM score_versions WHERE score_id = ? AND choir_id = ? AND state = 'ready'
       AND candidate_expires_at IS NULL
       AND (retention_expires_at IS NULL OR retention_expires_at > ?)
     ORDER BY version_number DESC`,
  ).bind(scoreId, choirId, Date.now()).all();
  context.header("Cache-Control", "no-store");
  return context.json({ ...score, versions: versions.results });
});

// Both publishing a candidate and selecting a retained version use the same CAS.
versionRoutes.post(`${path}/:versionId/publish`, async (context) => {
  const { choirId, scoreId, versionId } = context.req.param();
  const membership = await requireChoirAdmin(createDatabase(context.env.DB), await resolveContextPrincipal(context), choirId);
  const parsed = versionPublicationRequestSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "invalid_revision" }, 400);
  const now = Date.now();
  const result = await context.env.DB.prepare(
    `UPDATE scores SET current_version_id = ?, updated_at = ?
     WHERE id = ? AND choir_id = ? AND trashed_at IS NULL AND version_revision = ?
       AND current_version_id <> ?
       AND EXISTS (SELECT 1 FROM memberships WHERE id = ? AND status = 'active' AND role = 'admin')
       AND EXISTS (SELECT 1 FROM score_versions WHERE id = ? AND score_id = scores.id
         AND state = 'ready' AND etag IS NOT NULL
         AND (retention_expires_at IS NULL OR retention_expires_at > ?)
         AND (candidate_expires_at IS NULL OR (candidate_expires_at > ? AND base_revision = ?)))`,
  ).bind(versionId, now, scoreId, choirId, parsed.data.expectedRevision, versionId,
    membership.id, versionId, now, now, parsed.data.expectedRevision).run();
  if (result.meta.changes !== 1) {
    // A retry of this exact publication is harmless; an intervening publication isn't.
    const same = await context.env.DB.prepare(
      `SELECT id FROM scores WHERE id = ? AND choir_id = ? AND trashed_at IS NULL
       AND current_version_id = ? AND version_revision = ?`,
    ).bind(scoreId, choirId, versionId, parsed.data.expectedRevision + 1).first();
    if (!same) return context.json({ error: "version_conflict" }, 409);
  }
  return context.body(null, 204);
});

versionRoutes.delete(`${path}/:versionId`, async (context) => {
  const { choirId, scoreId, versionId } = context.req.param();
  const membership = await requireChoirAdmin(createDatabase(context.env.DB), await resolveContextPrincipal(context), choirId);
  await context.env.DB.prepare(
    `DELETE FROM score_versions WHERE id = ? AND score_id = ? AND choir_id = ?
       AND candidate_expires_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM memberships WHERE id = ? AND status = 'active' AND role = 'admin')
       AND NOT EXISTS (SELECT 1 FROM scores WHERE current_version_id = score_versions.id)`,
  ).bind(versionId, scoreId, choirId, membership.id).run();
  return context.body(null, 204);
});
