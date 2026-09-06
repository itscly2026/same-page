import assert from "node:assert/strict";
import test from "node:test";

import { resolveFixtureRequest } from "./fixtures.mjs";
import { createVisualReportManifest, renderVisualReportHtml } from "./report.mjs";

test("unknown API requests fail closed instead of reaching the current Worker", () => {
  const response = resolveFixtureRequest({
    pathname: "/api/not-a-visual-fixture",
    identity: "guest",
  });
  assert.equal(response.status, 404);
  assert.equal(JSON.parse(response.body).error, "visual_fixture_not_found");
});

test("report renderer escapes scene metadata and links screenshots", () => {
  const manifest = createVisualReportManifest({
    commit: "abc123",
    generatedAt: "2026-08-31T12:00:00.000Z",
    captures: [
      {
        id: "home-guest",
        title: "首页 <匿名>",
        description: "固定场景",
        deviceLabel: "iPad Pro 11",
        route: "/",
        viewport: { width: 834, height: 1194 },
        pixels: { width: 1668, height: 2388 },
        screenshot: "screenshots/01-home-guest.png",
      },
    ],
  });
  const html = renderVisualReportHtml(manifest);
  assert.match(html, /首页 &lt;匿名&gt;/);
  assert.match(html, /screenshots\/01-home-guest\.png/);
  assert.match(html, /834 × 1194/);
});
