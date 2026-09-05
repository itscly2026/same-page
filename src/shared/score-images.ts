import { z } from "zod";

export const imageEdges = [2048, 3072] as const;
export const imageOutputSpec = "png-rgb-v1";
export const imageAssetSchema = z.object({
  edge: z.union([z.literal(2048), z.literal(3072)]),
  width: z.number().int().positive().max(3072), height: z.number().int().positive().max(3072),
  sizeBytes: z.number().int().positive().max(32 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const imagePageSchema = z.object({
  pageNumber: z.number().int().positive(),
  width: z.number().positive().max(100_000), height: z.number().positive().max(100_000),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  crop: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  assets: z.array(imageAssetSchema).length(2).refine(a => a[0].edge === 2048 && a[1].edge === 3072),
});
export const imageManifestSchema = z.object({
  versionId: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().uuid(), spec: z.literal(imageOutputSpec), engine: z.string().regex(/^pdfium-[0-9.]+$/),
  pages: z.array(imagePageSchema).min(1).max(200),
}).refine(m => m.pages.every((p, i) => p.pageNumber === i + 1));
export type ImageManifest = z.infer<typeof imageManifestSchema>;
export type ImageAsset = z.infer<typeof imageAssetSchema>;
export type ScoreDisplayMode = "pdf" | "images";
export function scoreImagesPath(choirId: string, scoreId: string, versionId: string) {
  return `/api/choirs/${encodeURIComponent(choirId)}/scores/${encodeURIComponent(scoreId)}/versions/${encodeURIComponent(versionId)}/images`;
}
export function pageImagePath(base: string, manifest: ImageManifest, page: number, edge: number) {
  return `${base}/${manifest.generation}/${page}/${edge}.png`;
}
