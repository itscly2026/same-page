import { describe, expect, it } from "vitest";

import {
  resolveSharedLayerPreference,
  scoreLayerPreferenceUpdateSchema,
} from "./annotations";

describe("scoreLayerPreferenceUpdateSchema", () => {
  it("accepts only score subscription overrides", () => {
    expect(scoreLayerPreferenceUpdateSchema.safeParse({ subscribed: false }).success).toBe(true);
    expect(scoreLayerPreferenceUpdateSchema.safeParse({ subscribed: null }).success).toBe(true);
    expect(scoreLayerPreferenceUpdateSchema.safeParse({ colorOverride: "#445566" }).success).toBe(false);
  });
});

describe("resolveSharedLayerPreference", () => {
  it("uses a score subscription override and a drive color independently", () => {
    expect(resolveSharedLayerPreference({
      productDefaultColor: "#111111",
      adminDefaultColor: "#222222",
      driveSubscribed: false,
      driveColorOverride: "#333333",
      scoreSubscriptionOverride: true,
    })).toEqual({
      subscribed: true,
      subscriptionSource: "score",
      displayColor: "#333333",
      colorSource: "drive",
    });
  });

  it("inherits drive subscription and administrator color independently", () => {
    expect(resolveSharedLayerPreference({
      productDefaultColor: "#111111",
      adminDefaultColor: "#222222",
      driveSubscribed: false,
      driveColorOverride: null,
      scoreSubscriptionOverride: null,
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
    })).toEqual({
      subscribed: true,
      subscriptionSource: "product",
      displayColor: "#111111",
      colorSource: "product",
    });
  });
});
