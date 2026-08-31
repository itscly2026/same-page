import { z } from "zod";

export const PASSWORD_POLICY = {
  minLength: 10,
  maxLength: 128,
} as const;

export const authFlowResponseSchema = z.object({
  flow: z.enum(["sign-in", "sign-up"]),
});
