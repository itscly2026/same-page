import { z } from "zod";

export const joinCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-HJ-NP-Z2-9]{8}$/);

export const displayNameSchema = z.string().trim().min(1).max(40);

export const guestSessionRequestSchema = z.object({
  joinCode: joinCodeSchema,
});

export const joinChoirRequestSchema = z.object({
  joinCode: joinCodeSchema,
  displayName: displayNameSchema,
});

export const joinCurrentGuestRequestSchema = z.object({
  displayName: displayNameSchema,
});

export const rotateJoinCodeResponseSchema = z.object({
  joinCode: joinCodeSchema,
  joinCodeVersion: z.number().int().positive(),
});

export const choirSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
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
