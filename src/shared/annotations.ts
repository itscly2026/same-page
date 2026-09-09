import { z } from "zod";

export const sharedLayerSlotSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type SharedLayerSlot = z.infer<typeof sharedLayerSlotSchema>;

export const defaultSharedLayers: ReadonlyArray<{
  slot: SharedLayerSlot;
  name: string;
  defaultColor: string;
  sortOrder: number;
}> = [
  { slot: "E", name: "Ensemble", defaultColor: "#dc2626", sortOrder: 0 },
  { slot: "S", name: "Soprano", defaultColor: "#dc2626", sortOrder: 1 },
  { slot: "A", name: "Alto", defaultColor: "#dc2626", sortOrder: 2 },
  { slot: "T", name: "Tenor", defaultColor: "#dc2626", sortOrder: 3 },
  { slot: "B", name: "Bass", defaultColor: "#dc2626", sortOrder: 4 },
];

export const normalizedCoordinateSchema = z.number().finite().min(0).max(1);

export const DEFAULT_TEXT_FONT_SCALE = 0.024;
export const MIN_TEXT_FONT_SCALE = 0.012;
export const MAX_TEXT_FONT_SCALE = 0.08;
export const textFontScaleSchema = z
  .number()
  .finite()
  .min(MIN_TEXT_FONT_SCALE)
  .max(MAX_TEXT_FONT_SCALE);

const annotationBaseSchema = z.object({
  pageNumber: z.number().int().positive().max(10_000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const textAnnotationPayloadSchema = annotationBaseSchema.extend({
  kind: z.literal("text"),
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
  fontScale: textFontScaleSchema.default(DEFAULT_TEXT_FONT_SCALE),
  text: z.string().trim().min(1).max(1_000),
});

export const inkPointSchema = z.object({
  x: normalizedCoordinateSchema,
  y: normalizedCoordinateSchema,
  pressure: z.number().finite().min(0).max(1).optional(),
  tiltX: z.number().finite().min(-90).max(90).optional(),
  tiltY: z.number().finite().min(-90).max(90).optional(),
  twist: z.number().finite().min(0).max(359).optional(),
});

export const inkAnnotationPayloadSchema = annotationBaseSchema.extend({
  kind: z.literal("ink"),
  points: z.array(inkPointSchema).min(2).max(5_000),
  brush: z.enum(["pen", "highlighter"]),
  nib: z.enum(["round", "chisel"]),
  pressureMode: z.enum(["uniform", "pressure"]),
  strokeWidth: z.number().finite().min(0.001).max(0.06),
  opacity: z.number().finite().min(0.05).max(1).optional(),
});

export const shapeAnnotationPayloadSchema = annotationBaseSchema.extend({
  kind: z.literal("shape"),
  shape: z.enum(["rectangle", "ellipse"]),
  x: normalizedCoordinateSchema, y: normalizedCoordinateSchema,
  width: normalizedCoordinateSchema, height: normalizedCoordinateSchema,
  strokeWidth: z.number().finite().min(0.001).max(0.06),
});

export const annotationPayloadSchema = z.discriminatedUnion("kind", [
  textAnnotationPayloadSchema,
  inkAnnotationPayloadSchema,
  shapeAnnotationPayloadSchema,
]);

export type AnnotationPayload = z.infer<typeof annotationPayloadSchema>;

export const annotationOperationSchema = z
  .object({
    opId: z.uuid(),
    annotationId: z.uuid(),
    layerId: z.uuid(),
    baseVersion: z.number().int().nonnegative(),
    type: z.enum(["upsert", "delete"]),
    payload: annotationPayloadSchema.nullable(),
  })
  .superRefine((operation, context) => {
    if (
      (operation.type === "upsert" && operation.payload === null) ||
      (operation.type === "delete" && operation.payload !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "payload must match the operation type",
        path: ["payload"],
      });
    }
  });

export const annotationPushRequestSchema = z.object({
  operations: z.array(annotationOperationSchema).min(1).max(100),
});

const colorOverrideSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();

export const driveLayerPreferenceUpdateSchema = z.object({
  subscribed: z.boolean().optional(),
  colorOverride: colorOverrideSchema.optional(),
});

export const scoreLayerPreferenceUpdateSchema = z
  .object({
    subscribed: z.boolean().nullable().optional(),
    colorOverride: colorOverrideSchema.optional(),
  })
  .strict();

export const sharedLayerSettingUpdateSchema = z.object({
  defaultColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  name: z.string().trim().min(1).max(60).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export const sharedLayerCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  defaultColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();

export interface ResolvedSharedLayerPreference {
  subscribed: boolean;
  subscriptionSource: "score" | "drive" | "product";
  displayColor: string;
  colorSource: "score" | "drive" | "admin" | "product";
}

export function resolveSharedLayerPreference(input: {
  productDefaultColor: string;
  adminDefaultColor: string | null;
  driveSubscribed: boolean | null;
  driveColorOverride: string | null;
  scoreSubscriptionOverride: boolean | null;
  scoreColorOverride?: string | null;
}): ResolvedSharedLayerPreference {
  const subscribed =
    input.scoreSubscriptionOverride ?? input.driveSubscribed ?? true;
  const subscriptionSource =
    input.scoreSubscriptionOverride !== null
      ? "score"
      : input.driveSubscribed !== null
        ? "drive"
        : "product";
  const displayColor =
    input.scoreColorOverride ??
    input.driveColorOverride ??
    input.adminDefaultColor ??
    input.productDefaultColor;
  const colorSource = input.scoreColorOverride ? "score" : input.driveColorOverride
    ? "drive"
    : input.adminDefaultColor
      ? "admin"
      : "product";
  return { subscribed, subscriptionSource, displayColor, colorSource };
}

export interface AnnotationLayerSummary {
  id: string;
  kind: "shared" | "personal";
  sharedSlot: SharedLayerSlot | null;
  name: string;
  sortOrder: number;
  subscribed: boolean;
  subscriptionSource: "score" | "drive" | "product" | "personal";
  displayColor: string;
  colorSource: "score" | "drive" | "admin" | "product" | "personal";
  adminDefaultColor: string | null;
  driveSubscribed: boolean | null;
  driveColorOverride: string | null;
  scoreSubscriptionOverride: boolean | null;
  scoreColorOverride?: string | null;
  canEdit: boolean;
  sharing?: boolean;
  canShare?: boolean;
  revision?: number;
  deletedAt?: number | null;
}

export interface AnnotationObjectRecord {
  id: string;
  layerId: string;
  version: number;
  deleted: boolean;
  payload: AnnotationPayload | null;
  createdByDisplayName: string;
  updatedByDisplayName: string;
  updatedAt: number;
}

export const annotationLayerSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(["shared", "personal"]),
  sharedSlot: sharedLayerSlotSchema.nullable(),
  name: z.string(),
  sortOrder: z.number().int(),
  subscribed: z.boolean(),
  subscriptionSource: z.enum(["score", "drive", "product", "personal"]),
  displayColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  colorSource: z.enum(["score", "drive", "admin", "product", "personal"]),
  adminDefaultColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  driveSubscribed: z.boolean().nullable(),
  driveColorOverride: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  scoreSubscriptionOverride: z.boolean().nullable(),
  scoreColorOverride: colorOverrideSchema.optional(),
  canEdit: z.boolean(),
  sharing: z.boolean().optional(),
  canShare: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
  deletedAt: z.number().nullable().optional(),
});

export const annotationObjectRecordSchema = z.object({
  id: z.uuid(),
  layerId: z.uuid(),
  version: z.number().int().positive(),
  deleted: z.boolean(),
  payload: annotationPayloadSchema.nullable(),
  createdByDisplayName: z.string(),
  updatedByDisplayName: z.string(),
  updatedAt: z.number().int().nonnegative(),
});

export const annotationPullResponseSchema = z.object({
  hasMore: z.boolean().optional(),
  cursor: z.number().int().nonnegative(),
  objects: z.array(annotationObjectRecordSchema),
});

export const annotationPushResponseSchema = z.object({
  results: z.array(z.object({
    opId: z.string(),
    status: z.enum(["accepted", "conflict", "op_id_reused", "permission_denied"]),
    object: annotationObjectRecordSchema.nullable().optional(),
  })),
});

export const annotationLayerListResponseSchema = z.object({
  sharedLayerRevision: z.number().int().nonnegative(),
  layers: z.array(annotationLayerSummarySchema),
  permissions: z.object({ canManageLayers: z.boolean() }),
});

const driveIdentitySchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const driveLayerPreferenceSummarySchema = z.object({
  slot: sharedLayerSlotSchema,
  name: z.string(),
  subscribed: z.boolean(),
  colorOverride: colorOverrideSchema,
  adminDefaultColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  displayColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  colorSource: z.enum(["drive", "admin", "product"]),
});

export type DriveLayerPreferenceSummary = z.infer<
  typeof driveLayerPreferenceSummarySchema
>;

export const driveLayerPreferencesResponseSchema = z.object({
  drive: driveIdentitySchema,
  layers: z.array(driveLayerPreferenceSummarySchema),
});

export const sharedLayerLifecycleSchema = z.object({
  action: z.enum(["delete", "restore"]),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const sharedLayerManagementSummarySchema = z.object({
  slot: sharedLayerSlotSchema,
  name: z.string(),
  defaultColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  grantedMemberCount: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  deletedAt: z.number().nullable(),
  recoverUntil: z.number().nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
});

export type SharedLayerManagementSummary = z.infer<
  typeof sharedLayerManagementSummarySchema
>;

export const sharedLayerAvailabilitySchema = z.object({
  sharedLayerRevision: z.number().int().nonnegative(),
  activeSharedSlots: z.array(sharedLayerSlotSchema),
});

export const sharedLayerManagementResponseSchema = sharedLayerAvailabilitySchema.extend({
  drive: driveIdentitySchema,
  layers: z.array(sharedLayerManagementSummarySchema),
});

export const sharedLayerOrderUpdateSchema = z.object({ direction: z.enum(["up", "down"]) });
