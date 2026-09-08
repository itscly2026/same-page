import { driveCapabilitiesSchema, permissionSetSchema } from "./drive-permissions";
import { z } from "zod";
export const lifecycleMembershipSchema = z.object({
  id: z.string(), choirId: z.string(), name: z.string(), displayName: z.string(),
  isPreviewEntry: z.number(), isOwner: z.number(), status: z.enum(["active", "removed"]),
  revision: z.number(), removedAt: z.number().nullable(),
});
export const userLifecycleSchema = z.object({
  userId: z.string(), reauthenticated: z.boolean(), methods: z.array(z.string()),
  deletion: z.object({ deletionId: z.string(), expiresAt: z.number(), authMethod: z.string() }).nullable(),
  memberships: z.array(lifecycleMembershipSchema),
});
export const managedMembershipsSchema = z.object({ capabilities: driveCapabilitiesSchema, actorId: z.string(), memberships: z.array(z.object({
  id: z.string(), displayName: z.string(), isOwner: z.number(),
  operations: permissionSetSchema, management: permissionSetSchema, status: z.enum(["active", "removed"]), removedAt: z.number().nullable().optional(), revision: z.number(), userDeleted: z.number().optional(), recoverable: z.number().optional(),
})) });
