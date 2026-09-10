import { driveCapabilitiesSchema } from "./drive-permissions";
import { z } from "zod";

import { choirSummarySchema } from "./choirs";
import { canonicalScoreFileNameKey } from "./score-file-name-key.mjs";

export const MAX_PDF_PAGES = 500;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const SCORE_TRASH_RETENTION_DAYS = 30;

export const scoreFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => value !== "." && value !== "..", "invalid file name");

export function scoreFileNameKey(fileName: string) {
  return canonicalScoreFileNameKey(fileName);
}

export const scoreRenameRequestSchema = z.object({
  fileName: scoreFileNameSchema,
});

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
  fileName: z.string(),
  currentVersion: scoreVersionSummarySchema,
  updatedAt: z.number(),
});

export const trashedScoreSummarySchema = scoreSummarySchema.extend({
  trashedAt: z.number(),
  trashExpiresAt: z.number(),
});

const scoreStorageSchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});

export const scoreListResponseSchema = z.object({
  scores: z.array(scoreSummarySchema),
  storage: scoreStorageSchema,
  permissions: z.object({
    capabilities: driveCapabilitiesSchema,
  }),
});

export const driveBootstrapResponseSchema = scoreListResponseSchema.extend({
  choir: choirSummarySchema,
  permissions: z.object({
    capabilities: driveCapabilitiesSchema,
    access: z.enum(["membership", "preview", "guest"]),
  }),
});

export const scoreTrashResponseSchema = z.object({
  scores: z.array(trashedScoreSummarySchema),
  storage: scoreStorageSchema,
});

export const scoreCloudStateSchema = z.object({
  state: z.enum(["active", "trashed"]),
  trashExpiresAt: z.number().optional(),
});

export const readerScoreStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("active"),
    score: scoreSummarySchema,
    permissions: z.object({ capabilities: driveCapabilitiesSchema }),
  }),
  z.object({
    state: z.literal("trashed"),
    trashExpiresAt: z.number().optional(),
  }),
]);

export type ScoreSummary = z.infer<typeof scoreSummarySchema>;
export type TrashedScoreSummary = z.infer<typeof trashedScoreSummarySchema>;
export type ScoreListResponse = z.infer<typeof scoreListResponseSchema>;
export type DriveBootstrapResponse = z.infer<typeof driveBootstrapResponseSchema>;
export type ReaderScoreState = z.infer<typeof readerScoreStateSchema>;

export const versionPublicationRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
export const scoreVersionHistorySchema = z.object({
  currentVersionId: z.string(),
  revision: z.number().int().positive(),
  versions: z.array(scoreVersionSummarySchema.extend({
    retentionExpiresAt: z.number().nullable(),
  })),
});
export type ScoreVersionHistory = z.infer<typeof scoreVersionHistorySchema>;
