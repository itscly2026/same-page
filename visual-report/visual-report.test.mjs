import assert from "node:assert/strict";
import test from "node:test";

import { resolveFixtureRequest, visualFixture } from "./fixtures.mjs";
import { createVisualReportManifest, renderVisualReportHtml } from "./report.mjs";
import {
  validateVisualReportScenarios,
  visualReportScenarios,
} from "./scenarios.mjs";

test("visual report scenarios have stable unique ids and cover iPad plus narrow layouts", () => {
  assert.equal(validateVisualReportScenarios(), visualReportScenarios);
  assert.equal(
    new Set(visualReportScenarios.map((scenario) => scenario.id)).size,
    visualReportScenarios.length,
  );
  assert.deepEqual(
    new Set(visualReportScenarios.map((scenario) => scenario.device)),
    new Set(["portrait", "landscape", "narrow"]),
  );
});

test("fixture resolver isolates guest and member sessions", () => {
  const socialProviders = resolveFixtureRequest({
    pathname: "/api/auth/social-providers",
    identity: "guest",
  });
  const guest = resolveFixtureRequest({
    pathname: "/api/auth/get-session",
    identity: "guest",
  });
  const member = resolveFixtureRequest({
    pathname: "/api/auth/get-session",
    identity: "member",
  });
  assert.equal(JSON.parse(guest.body), null);
  assert.equal(JSON.parse(member.body).user.email, "member@visual.invalid");
  assert.deepEqual(JSON.parse(socialProviders.body), {
    providers: ["google", "wechat"],
  });
  const preview = resolveFixtureRequest({
    pathname: "/api/guest/preview-choir",
    identity: "guest",
  });
  assert.equal(JSON.parse(preview.body).choir.name, "公开体验云盘");
});

test("fixture resolver returns current score shapes and a generated PDF without secrets", () => {
  const scores = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/scores",
    identity: "admin",
  });
  const pdf = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/scores/visual-score/pdf",
    identity: "member",
  });
  const payload = JSON.parse(scores.body);
  assert.equal(payload.permissions.canManage, true);
  assert.equal(payload.scores[0].currentVersion.sha256, visualFixture.samplePdfSha256);
  assert.equal(pdf.contentType, "application/pdf");
  assert.equal(pdf.body.subarray(0, 8).toString("ascii"), "%PDF-1.4");
  assert.doesNotMatch(pdf.body.toString("ascii"), /token|password|invite/i);
});

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
