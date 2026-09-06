import { describe, expect, it } from "vitest";

import {
  configuredSocialProviderIds,
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

});
