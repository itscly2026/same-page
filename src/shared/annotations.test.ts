import { describe, expect, it } from "vitest";

import { resolveSharedLayerPreference } from "./annotations";

describe("resolveSharedLayerPreference", () => {
  it("uses score overrides before drive and administrator defaults", () => {
    expect(resolveSharedLayerPreference({
      productDefaultColor: "#111111",
      adminDefaultColor: "#222222",
      driveSubscribed: false,
      driveColorOverride: "#333333",
      scoreSubscriptionOverride: true,
      scoreColorOverride: "#444444",
    })).toEqual({
      subscribed: true,
      subscriptionSource: "score",
      displayColor: "#444444",
      colorSource: "score",
    });
  });

  it("inherits drive subscription and administrator color independently", () => {
    expect(resolveSharedLayerPreference({
      productDefaultColor: "#111111",
      adminDefaultColor: "#222222",
      driveSubscribed: false,
      driveColorOverride: null,
      scoreSubscriptionOverride: null,
      scoreColorOverride: null,
    })).toEqual({
      subscribed: false,
      subscriptionSource: "drive",
      displayColor: "#222222",
      colorSource: "admin",
    });
  });

  it("starts subscribed with the product color when no preference exists", () => {
    expect(resolveSharedLayerPreference({
      productDefaultColor: "#111111",
      adminDefaultColor: null,
      driveSubscribed: null,
      driveColorOverride: null,
      scoreSubscriptionOverride: null,
      scoreColorOverride: null,
    })).toEqual({
      subscribed: true,
      subscriptionSource: "product",
      displayColor: "#111111",
      colorSource: "product",
    });
  });
});
