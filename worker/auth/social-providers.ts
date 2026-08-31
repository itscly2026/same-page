import type { BetterAuthOptions } from "better-auth";

import type { SocialAuthProvider } from "../../src/shared/auth";

export interface SocialProviderBindings {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WECHAT_CLIENT_ID?: string;
  WECHAT_CLIENT_SECRET?: string;
}

export function configuredSocialProviderIds(
  bindings: SocialProviderBindings,
): SocialAuthProvider[] {
  const providers: SocialAuthProvider[] = [];
  if (hasCredentials(bindings.GOOGLE_CLIENT_ID, bindings.GOOGLE_CLIENT_SECRET)) {
    providers.push("google");
  }
  if (hasCredentials(bindings.WECHAT_CLIENT_ID, bindings.WECHAT_CLIENT_SECRET)) {
    providers.push("wechat");
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
  const wechatEnabled = hasCredentials(
    bindings.WECHAT_CLIENT_ID,
    bindings.WECHAT_CLIENT_SECRET,
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
    ...(wechatEnabled
      ? {
          wechat: {
            clientId: bindings.WECHAT_CLIENT_ID!,
            clientSecret: bindings.WECHAT_CLIENT_SECRET!,
            lang: "cn" as const,
          },
        }
      : {}),
  };
}

function hasCredentials(clientId?: string, clientSecret?: string) {
  return Boolean(clientId?.trim() && clientSecret?.trim());
}
