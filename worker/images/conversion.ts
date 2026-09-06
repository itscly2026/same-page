import { openRenderer, type RendererFrames } from "./renderer";
import { z } from "zod";
import { imageEdges, imageManifestSchema, imageOutputSpec, type ImageManifest } from "../../src/shared/score-images";
import type { Env } from "../env";

export function imageObjectKey(version: string, generation: string, page: number, edge: number) {
  return `derived/${version}/${generation}/${page}-${edge}.png`;
}
const geometrySchema = z.object({
  engine: z.string().regex(/^pdfium-[0-9.]+$/),
  pages: z.array(z.object({ pageNumber: z.number().int().positive(), width: z.number().positive(), height: z.number().positive(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    crop: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  })).min(1).max(200),
});
export async function convertScoreImages(env: Env, job: { versionId: string; generation: string }) {
  const { versionId, generation } = job;
  const source = await env.DB.prepare(`SELECT v.object_key, v.sha256, v.page_count FROM score_versions v
    JOIN score_image_jobs j ON j.version_id = v.id WHERE v.id = ? AND j.generation = ? AND j.state = 'preparing'`)
    .bind(versionId, generation).first<{ object_key: string; sha256: string; page_count: number }>();
  if (!source) return;
  await env.DB.prepare("DELETE FROM score_image_objects WHERE version_id = ? AND generation <> ?").bind(versionId, generation).run();
  const signal = AbortSignal.timeout(180_000);
  let stage = "source";
  let frames: RendererFrames | undefined;
  try {
    const pdf = await env.SCORES_BUCKET.get(source.object_key);
    if (!pdf || pdf.size > 20 * 1024 * 1024 || source.page_count > 200) throw new Error("source-limit");
    const bytes = await pdf.arrayBuffer();
    if (await sha256(bytes) !== source.sha256) throw new Error("source-checksum");
    stage = "inspect";
    frames = await openRenderer(env, bytes, source.sha256, signal);
    const geometry = geometrySchema.parse(JSON.parse(new TextDecoder().decode(await frames.frame(256 * 1024))));
    if (geometry.pages.length !== source.page_count) throw new Error("page-count");
    const pages: ImageManifest["pages"] = [];
    let totalBytes = 0;
    for (const [index, page] of geometry.pages.entries()) {
      if (page.pageNumber !== index + 1) throw new Error("page-count");
      signal.throwIfAborted();
      const assets: ImageManifest["pages"][number]["assets"] = [];
      for (const edge of imageEdges) {
        stage = "render";
        const data = await frames.frame(32 * 1024 * 1024);
        if (data.byteLength < 24 || data.byteLength > 32 * 1024 * 1024) throw new Error("image-size");
        const header = new DataView(data);
        if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a) throw new Error("image-format");
        const width = header.getUint32(16), height = header.getUint32(20);
        if (!width || !height || Math.max(width, height) > edge || width * height > 9_437_184) throw new Error("pixel-limit");
        totalBytes += data.byteLength;
        if (totalBytes > 512 * 1024 * 1024) throw new Error("output-limit");
        const hash = await sha256(data), key = imageObjectKey(versionId, generation, page.pageNumber, edge);
        stage = "register";
        const registered = await env.DB.prepare(`INSERT OR IGNORE INTO score_image_objects(object_key, version_id, generation)
          SELECT ?, version_id, generation FROM score_image_jobs WHERE version_id = ? AND generation = ? AND state = 'preparing'`)
          .bind(key, versionId, generation).run();
        if (!registered.meta.changes) throw new Error("job-expired");
        stage = "store";
        await env.SCORES_BUCKET.put(key, data, { httpMetadata: { contentType: "image/png" }, sha256: hash });
        if (!await env.DB.prepare("SELECT object_key FROM score_image_objects WHERE object_key = ?").bind(key).first()) {
          await env.SCORES_BUCKET.delete(key); throw new Error("job-expired");
        }
        assets.push({ edge, width, height, sizeBytes: data.byteLength, sha256: hash });
      }
      pages.push({ ...page, assets });
    }
    await frames.finish();
    stage = "manifest";
    const manifest = imageManifestSchema.parse({ versionId, sourceSha256: source.sha256, generation, spec: imageOutputSpec, engine: geometry.engine, pages });
    await env.DB.prepare("UPDATE score_image_jobs SET state = 'ready', manifest = ?, updated_at = ? WHERE version_id = ? AND generation = ? AND state = 'preparing'")
      .bind(JSON.stringify(manifest), Date.now(), versionId, generation).run();
  } catch (error) {
    const known = ["source-limit", "source-checksum", "render-failed", "page-count", "image-size", "image-format", "pixel-limit", "output-limit", "job-expired"];
    // Emit only fixed phase/reason names; never raw renderer, PDF or D1 errors.
    console.error(JSON.stringify({ event: "score_image_conversion_failed", stage,
      reason: error instanceof Error && known.includes(error.message) ? error.message : "external-error" }));
    await env.DB.prepare("DELETE FROM score_image_objects WHERE version_id = ? AND generation = ?").bind(versionId, generation).run();
    await env.DB.prepare("UPDATE score_image_jobs SET state = 'failed', failure = 'conversion-failed', updated_at = ? WHERE version_id = ? AND generation = ?")
      .bind(Date.now(), versionId, generation).run();
  } finally {
    await frames?.close();
  }
}
async function sha256(data: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(b => b.toString(16).padStart(2, "0")).join("");
}
