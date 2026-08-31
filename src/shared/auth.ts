import { z } from "zod";

export const PASSWORD_POLICY = {
  minLength: 10,
  maxLength: 128,
} as const;

export const authFlowResponseSchema = z.object({
  flow: z.enum(["sign-in", "sign-up"]),
});

export const socialAuthProviderSchema = z.enum(["google", "wechat"]);
export type SocialAuthProvider = z.infer<typeof socialAuthProviderSchema>;

export const socialAuthProvidersResponseSchema = z.object({
  providers: z.array(socialAuthProviderSchema),
});

const INTERNAL_AUTH_EMAIL_SUFFIX = ".placeholder.invalid";

export function isInternalAuthEmail(email: string) {
  return email.trim().toLowerCase().endsWith(INTERNAL_AUTH_EMAIL_SUFFIX);
}
