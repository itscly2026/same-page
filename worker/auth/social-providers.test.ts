import { describe, expect, it } from "vitest";

import {
  configuredSocialProviderIds,
  createSocialProviderOptions,
} from "./social-providers";

describe("social provider configuration", () => {
  it("enables only providers with complete credential pairs", () => {
    expect(configuredSocialProviderIds({})).toEqual([]);
    expect(
      configuredSocialProviderIds({
        GOOGLE_CLIENT_ID: "google-id",
        WECHAT_CLIENT_ID: "wechat-id",
        WECHAT_CLIENT_SECRET: "wechat-secret",
      }),
    ).toEqual(["wechat"]);
  });

  it("uses the providers' minimum defaults and the Website App WeChat provider", () => {
    const providers = createSocialProviderOptions({
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      WECHAT_CLIENT_ID: "wechat-id",
      WECHAT_CLIENT_SECRET: "wechat-secret",
    });

    expect(providers.google).toMatchObject({
      clientId: "google-id",
    });
    expect(providers.google).not.toHaveProperty("scope");
    expect(providers.wechat).toMatchObject({
      clientId: "wechat-id",
      lang: "cn",
    });
  });
});
