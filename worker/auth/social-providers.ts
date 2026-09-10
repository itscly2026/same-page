import type { BetterAuthOptions } from "better-auth";

import type { SocialAuthProvider } from "../../src/shared/auth";

export interface SocialProviderBindings {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function configuredSocialProviderIds(
  bindings: SocialProviderBindings,
): SocialAuthProvider[] {
  const providers: SocialAuthProvider[] = [];
  if (hasCredentials(bindings.GOOGLE_CLIENT_ID, bindings.GOOGLE_CLIENT_SECRET)) {
    providers.push("google");
  }
  return providers;
}

export function createSocialProviderOptions(
  bindings: SocialProviderBindings,
): NonNullable<BetterAuthOptions["socialProviders"]> {
  const googleEnabled = hasCredentials(
    bindings.GOOGLE_CLIENT_ID,
    bindings.GOOGLE_CLIENT_SECRET,
  );

  return {
    ...(googleEnabled
      ? {
          google: {
            clientId: bindings.GOOGLE_CLIENT_ID!,
            clientSecret: bindings.GOOGLE_CLIENT_SECRET!,
          },
        }
      : {}),
  };
}

function hasCredentials(clientId?: string, clientSecret?: string) {
  return Boolean(clientId?.trim() && clientSecret?.trim());
}
