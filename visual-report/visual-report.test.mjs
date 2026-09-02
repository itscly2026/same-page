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
    new Set(["portrait", "landscape", "narrow", "desktop"]),
  );
  assert.ok(
    visualReportScenarios.some((scenario) => scenario.id === "reader-page-turn-half"),
  );
  assert.ok(
    visualReportScenarios.some((scenario) => scenario.id === "reader-layer-lock"),
  );
  for (const requiredId of [
    "reader-layers",
    "reader-layers-portrait",
    "layer-preferences",
    "shared-layer-management",
    "shared-layer-grants",
    "reader-text-ready",
    "reader-edit-shared-layer",
    "reader-edit-unsubscribed-layer",
    "reader-edit-unsubscribed-exit",
  ]) {
    assert.ok(
      visualReportScenarios.some((scenario) => scenario.id === requiredId),
      `missing required #69 capture: ${requiredId}`,
    );
  }
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
  const previewAdmission = resolveFixtureRequest({
    pathname: "/api/guest/session",
    method: "POST",
    identity: "member",
  });
  assert.match(previewAdmission.headers["set-cookie"], /same_page_guest=visual-preview/);
  const invalidInvite = resolveFixtureRequest({
    pathname: "/api/guest/session",
    method: "POST",
    identity: "guest",
  });
  assert.equal(invalidInvite.status, 404);
  const signedInPreview = resolveFixtureRequest({
    pathname: "/api/choirs/visual-preview-choir/scores",
    identity: "member",
    cookie: "same_page_guest=visual-preview",
  });
  assert.equal(JSON.parse(signedInPreview.body).permissions.canManage, false);
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

test("fixture resolver supports the narrow reader bootstrap", () => {
  const response = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/scores/visual-score/bootstrap",
    method: "GET",
    identity: "member",
  });
  const body = JSON.parse(response.body);

  assert.equal(body.state, "active");
  assert.equal(body.score.fileName, "排练示例 · 秋日合唱.pdf");
  assert.equal(body.permissions.canManage, false);
});

test("fixture resolver covers drive-scoped layer settings and edit isolation", () => {
  const preferences = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/shared-layer-preferences",
    identity: "member",
  });
  const management = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/shared-layers",
    identity: "admin",
  });
  const grants = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/shared-layers/E/grants",
    identity: "admin",
  });
  const editLayers = resolveFixtureRequest({
    pathname: "/api/choirs/visual-choir/scores/visual-score/layers",
    identity: "admin",
    scenarioId: "reader-edit-unsubscribed-layer",
  });

  assert.equal(JSON.parse(preferences.body).layers.length, 5);
  assert.equal(JSON.parse(management.body).layers.length, 5);
  assert.equal(JSON.parse(grants.body).members.length, 3);
  const ensemble = JSON.parse(editLayers.body).layers.find((layer) => layer.defaultSlot === "E");
  assert.equal(ensemble.subscribed, false);
  assert.equal(ensemble.canEdit, true);
  assert.equal(ensemble.scoreSubscriptionOverride, null);
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
