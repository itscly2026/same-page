import { z } from "zod";
import { readerScoreStateSchema } from "./scores";
import { annotationLayerListResponseSchema, annotationPullResponseSchema } from "./annotations";

export const readerSyncQuerySchema = z.object({
  cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  layerIds: z.string().default("[]").transform((value, context) => {
    try { return z.array(z.string().max(128)).max(1000).parse(JSON.parse(value)).sort(); }
    catch { context.addIssue({ code: "custom", message: "invalid_layer_ids" }); return z.NEVER; }
  }),
});
export const readerSyncResponseSchema = z.discriminatedUnion("state", [
  readerScoreStateSchema.options[0].extend({
    layers: annotationLayerListResponseSchema,
    annotations: annotationPullResponseSchema,
  }),
  readerScoreStateSchema.options[1],
]);
export type ReaderSyncResponse = z.infer<typeof readerSyncResponseSchema>;
