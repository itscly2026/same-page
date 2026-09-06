import { describe, expect, it } from "vitest";

import { navigationFallbackDenylist } from "./pwa-navigation";

describe("PWA navigation fallback", () => {
  it("never serves the application shell for API routes", () => {
    expect(isDenied("/api/auth/callback/google")).toBe(true);
    expect(isDenied("/api/health")).toBe(true);
  });

  it("keeps client-side routes eligible for the application shell", () => {
    expect(isDenied("/login")).toBe(false);
    expect(isDenied("/privacy")).toBe(false);
    expect(isDenied("/choirs/example-drive")).toBe(false);
  });
});

function isDenied(pathname: string) {
  return navigationFallbackDenylist.some((pattern) => pattern.test(pathname));
}
