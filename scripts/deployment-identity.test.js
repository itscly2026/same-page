import { describe, expect, it } from "vitest";

import {
  assetSetContainsBuildId,
  shellJavaScriptAssets,
} from "./deployment-identity.mjs";

describe("deployment identity", () => {
  it("follows entry and modulepreload assets because Vite may move build identity", () => {
    const html = `
      <script type="module" src="/assets/index-current.js"></script>
      <link rel="modulepreload" href="/assets/shared-current.js">
      <link rel="stylesheet" href="/assets/index-current.css">
    `;

    expect(shellJavaScriptAssets(html)).toEqual([
      "/assets/index-current.js",
      "/assets/shared-current.js",
    ]);
    expect(assetSetContainsBuildId(["entry", "shared build-123"], "build-123")).toBe(true);
  });
});
