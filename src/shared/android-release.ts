import { z } from "zod";

export const androidReleaseSchema = z.object({
  versionName: z.string().regex(/^\d+\.\d+\.\d+$/),
  versionCode: z.number().int().positive().max(2100000000),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AndroidRelease = z.infer<typeof androidReleaseSchema>;
