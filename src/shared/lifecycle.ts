import { z } from "zod";
export const lifecycleMembershipSchema = z.object({
  id: z.string(), choirId: z.string(), name: z.string(), displayName: z.string(),
  role: z.enum(["admin", "member"]), status: z.enum(["active", "removed"]),
  revision: z.number(), removedAt: z.number().nullable(), lastAdmin: z.number(),
});
export const userLifecycleSchema = z.object({
  userId: z.string(), reauthenticated: z.boolean(), methods: z.array(z.string()),
  deletion: z.object({ deletionId: z.string(), expiresAt: z.number(), authMethod: z.string() }).nullable(),
  memberships: z.array(lifecycleMembershipSchema),
});
export const managedMembershipsSchema = z.object({ memberships: z.array(z.object({
  id: z.string(), displayName: z.string(), role: z.enum(["admin", "member"]),
  status: z.enum(["active", "removed"]), removedAt: z.number().nullable(), revision: z.number(), userDeleted: z.number(), recoverable: z.number(),
})) });
