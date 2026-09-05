import { imageManifestSchema } from "../../src/shared/score-images";
import { imageObjectKey } from "./conversion";
import { Hono } from "hono";
import type { AppEnvironment } from "../env";
import { resolveScorePdfVersion } from "../scores/routes";

export const imageRoutes = new Hono<AppEnvironment>();
const path = "/choirs/:choirId/scores/:scoreId/versions/:versionId/images";
imageRoutes.get(path, async context => {
  const version = await resolveScorePdfVersion(context, context.req.param("versionId"));
  if (!version) return context.json({ error: "score_not_found" }, 404);
  context.header("Cache-Control", "no-store");
  const job = await context.env.DB.prepare("SELECT state, manifest, failure FROM score_image_jobs WHERE version_id = ?")
    .bind(version.version_id).first<{ state: string; manifest: string | null; failure: string | null }>();
  return context.json(job ? { state: job.state, ...(job.manifest ? { manifest: JSON.parse(job.manifest) } : {}), ...(job.failure ? { failure: job.failure } : {}) } : { state: "absent" });
});

imageRoutes.post(path, async context => {
  const version = await resolveScorePdfVersion(context, context.req.param("versionId"));
  if (!version) return context.json({ error: "score_not_found" }, 404);
  const now = Date.now(), generation = crypto.randomUUID();
  const result = await context.env.DB.prepare(`INSERT INTO score_image_jobs(version_id, generation, state, updated_at)
    VALUES (?, ?, 'preparing', ?) ON CONFLICT(version_id) DO UPDATE SET generation = excluded.generation,
    state = 'preparing', updated_at = excluded.updated_at, manifest = NULL, failure = NULL
    WHERE score_image_jobs.state = 'failed' OR (score_image_jobs.state = 'preparing' AND score_image_jobs.updated_at < ?)`)
    .bind(version.version_id, generation, now, now - 20 * 60_000).run();
  if (result.meta.changes) {
    try { await context.env.IMAGE_JOBS.send({ versionId: version.version_id, generation }); }
    catch {
      await context.env.DB.prepare("UPDATE score_image_jobs SET state = 'failed', failure = 'service-unavailable' WHERE version_id = ? AND generation = ?")
        .bind(version.version_id, generation).run();
      return context.json({ state: "failed", failure: "service-unavailable" }, 503);
    }
  }
  context.header("Cache-Control", "no-store");
  return context.json({ state: "preparing" }, 202);
});

imageRoutes.get(`${path}/:generation/:page/:asset`, async context => {
  const version = await resolveScorePdfVersion(context, context.req.param("versionId"));
  if (!version) return context.json({ error: "score_not_found" }, 404);
  const job = await context.env.DB.prepare("SELECT generation, manifest FROM score_image_jobs WHERE version_id = ? AND state = 'ready'")
    .bind(version.version_id).first<{ generation: string; manifest: string }>();
  if (!job || job.generation !== context.req.param("generation")) return context.json({ error: "image_version_mismatch" }, 409);
  const manifest = imageManifestSchema.parse(JSON.parse(job.manifest));
  const page = manifest.pages.find(p => String(p.pageNumber) === context.req.param("page"));
  const asset = page?.assets.find(a => `${a.edge}.png` === context.req.param("asset"));
  if (!page || !asset) return context.json({ error: "image_not_found" }, 404);
  const object = await context.env.SCORES_BUCKET.get(imageObjectKey(version.version_id, job.generation, page.pageNumber, asset.edge));
  if (!object) return context.json({ error: "image_unavailable" }, 503);
  return new Response(object.body, { headers: {
    "Content-Type": "image/png", "Content-Length": String(asset.sizeBytes), "Cache-Control": "private, no-store",
    "X-Content-SHA256": asset.sha256, "X-Score-Version": version.version_id, "X-Content-Type-Options": "nosniff",
  } });
});
