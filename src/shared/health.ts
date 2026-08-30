import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("same-page"),
  runtime: z.literal("cloudflare-worker"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
