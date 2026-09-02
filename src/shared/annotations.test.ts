import { describe, expect, it } from "vitest";

import {
  annotationLayerSummarySchema,
  resolveSharedLayerPreference,
  scoreLayerPreferenceUpdateSchema,
} from "./annotations";

describe("scoreLayerPreferenceUpdateSchema", () => {
  it("accepts only score subscription overrides", () => {
    expect(scoreLayerPreferenceUpdateSchema.safeParse({ subscribed: false }).success).toBe(true);
    expect(scoreLayerPreferenceUpdateSchema.safeParse({ subscribed: null }).success).toBe(true);
    expect(scoreLayerPreferenceUpdateSchema.safeParse({ colorOverride: "#445566" }).success).toBe(false);
  });

  it("does not expose a score-level color override in layer summaries", () => {
    const parsed = annotationLayerSummarySchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "shared",
      defaultSlot: "E",
      name: "Ensemble",
      sortOrder: 0,
      subscribed: true,
      subscriptionSource: "drive",
      displayColor: "#333333",
      colorSource: "drive",
      adminDefaultColor: "#222222",
      driveSubscribed: true,
      driveColorOverride: "#333333",
      scoreSubscriptionOverride: null,
      scoreColorOverride: "#444444",
      canEdit: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("scoreColorOverride");
    }
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
