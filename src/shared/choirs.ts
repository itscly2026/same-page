import { z } from "zod";

export const joinCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{8}$/);

export const displayNameSchema = z.string().trim().min(1).max(40);

export const guestAdmissionModeSchema = z.enum(["invite", "open"]);

const inviteGuestAdmissionSchema = z.object({
  admission: z.literal("invite"),
  joinCode: joinCodeSchema,
});

const openGuestAdmissionSchema = z.object({
  admission: z.literal("open"),
  choirId: z.string().min(1).max(128),
});

export const guestSessionRequestSchema = z.discriminatedUnion("admission", [
  inviteGuestAdmissionSchema,
  openGuestAdmissionSchema,
]);

export const joinChoirRequestSchema = z.discriminatedUnion("admission", [
  inviteGuestAdmissionSchema.extend({ displayName: displayNameSchema }),
  openGuestAdmissionSchema.extend({ displayName: displayNameSchema }),
]);

export const joinCurrentGuestRequestSchema = z.object({
  displayName: displayNameSchema,
});

export const rotateJoinCodeResponseSchema = z.object({
  joinCode: joinCodeSchema,
});

export const currentJoinCodeResponseSchema = z.object({
  joinCode: joinCodeSchema.nullable(),
});

export const choirSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  guestAdmissionMode: guestAdmissionModeSchema,
});

export const guestSessionResponseSchema = z.object({
  choir: choirSummarySchema,
  entryKind: z.enum(["admission", "preview"]),
});

export const guestJoinStateResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("joined"),
    choir: choirSummarySchema,
  }),
  z.object({
    status: z.literal("display-name-required"),
    choir: choirSummarySchema,
  }),
]);

export const previewChoirResponseSchema = z.object({
  choir: choirSummarySchema,
});

export const membershipSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  role: z.enum(["admin", "member"]),
  choir: choirSummarySchema,
});

export const choirMembershipsResponseSchema = z.object({
  memberships: z.array(membershipSummarySchema),
});

export type MembershipSummary = z.infer<typeof membershipSummarySchema>;
export type GuestAdmissionRequest = z.infer<
  typeof guestSessionRequestSchema
>;
export type ChoirSummary = z.infer<typeof choirSummarySchema>;
export type GuestSessionResponse = z.infer<typeof guestSessionResponseSchema>;

export const driveNameSchema = z.string().trim().min(1).max(100);
export const driveNameRequestSchema = z.object({ name: driveNameSchema, expectedRevision: z.number().int().nonnegative() }).strict();
export const memberDisplayNameRequestSchema = z.object({ displayName: displayNameSchema, expectedRevision: z.number().int().nonnegative() }).strict();
export const driveSettingsSchema = z.object({
  name: z.string(), nameRevision: z.number().int(), displayName: z.string(), membershipRevision: z.number().int(), canManage: z.boolean(),
});
