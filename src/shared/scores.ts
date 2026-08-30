import { z } from "zod";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const OLD_VERSION_RETENTION_DAYS = 30;

const optionalMetadata = z
  .string()
  .trim()
  .max(120)
  .transform((value) => value || null);

export const scoreMetadataSchema = z.object({
  title: z.string().trim().min(1).max(160),
  composer: optionalMetadata,
  arranger: optionalMetadata,
  sortOrder: z.coerce.number().int().min(-1_000_000).max(1_000_000).default(0),
});

export const scoreUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  composer: optionalMetadata.optional(),
  arranger: optionalMetadata.optional(),
  sortOrder: z.coerce
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

export const scoreStatusSchema = z.enum(["draft", "published", "archived"]);

export const scoreVersionSummarySchema = z.object({
  id: z.string(),
  versionNumber: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string(),
  etag: z.string(),
  pageCount: z.number().int().positive(),
  createdAt: z.number(),
});

export const scoreSummarySchema = z.object({
  id: z.string(),
  choirId: z.string(),
  title: z.string(),
  composer: z.string().nullable(),
  arranger: z.string().nullable(),
  sortOrder: z.number().int(),
  status: scoreStatusSchema,
  currentVersion: scoreVersionSummarySchema,
  updatedAt: z.number(),
});

export const scoreListResponseSchema = z.object({
  scores: z.array(scoreSummarySchema),
  storage: z.object({
    usedBytes: z.number().int().nonnegative(),
    limitBytes: z.number().int().positive(),
  }),
  permissions: z.object({
    canManage: z.boolean(),
  }),
});

export type ScoreSummary = z.infer<typeof scoreSummarySchema>;
export type ScoreListResponse = z.infer<typeof scoreListResponseSchema>;
