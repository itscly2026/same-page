import { z } from "zod";
import { driveCapabilitiesSchema } from "./drive-permissions";
import { guestAdmissionModeSchema } from "./choirs";

export const driveManagementSchema = z.object({
  isMember: z.boolean(),
  name: z.string(), guestAdmissionMode: guestAdmissionModeSchema,
  capabilities: driveCapabilitiesSchema,
  layers: z.array(z.object({ slot: z.string(), name: z.string(), active: z.number() })),
});
