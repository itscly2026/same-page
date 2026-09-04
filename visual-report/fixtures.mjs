import { createHash } from "node:crypto";

const FIXED_TIME = Date.parse("2026-08-31T12:00:00.000Z");
const samplePdf = createSampleScorePdf();
const samplePdfSha256 = createHash("sha256").update(samplePdf).digest("hex");

const choir = {
  id: "visual-choir",
  name: "示例云盘",
  guestAdmissionMode: "invite",
};

const previewChoir = {
  id: "visual-preview-choir",
  name: "公开体验云盘",
  guestAdmissionMode: "open",
};

const score = {
  id: "visual-score",
  choirId: choir.id,
  fileName: "排练示例 · 秋日合唱.pdf",
  currentVersion: {
    id: "visual-version-1",
    versionNumber: 1,
    sizeBytes: samplePdf.byteLength,
    sha256: samplePdfSha256,
    etag: "visual-fixture-v1",
    pageCount: 2,
    createdAt: FIXED_TIME,
  },
  updatedAt: FIXED_TIME,
};

const otherScores = [
  {
    ...score,
    id: "visual-score-2",
    fileName: "晨光练习.pdf",
    currentVersion: { ...score.currentVersion, id: "visual-version-2", sizeBytes: 286_720 },
  },
  {
    ...score,
    id: "visual-score-3",
    fileName: "终曲 · 合排版.pdf",
    currentVersion: { ...score.currentVersion, id: "visual-version-3", sizeBytes: 917_504 },
  },
];

const layers = [
  layer("00000000-0000-4000-8000-000000000001", "shared", "E", "Ensemble", 0, "#a12652"),
  layer("00000000-0000-4000-8000-000000000002", "shared", "S", "Soprano", 1, "#7c3aed"),
  layer("00000000-0000-4000-8000-000000000003", "shared", "A", "Alto", 2, "#8a5a00"),
  layer("00000000-0000-4000-8000-000000000004", "shared", "T", "Tenor", 3, "#0f766e"),
  layer("00000000-0000-4000-8000-000000000005", "shared", "B", "Bass", 4, "#3157a4"),
  layer("00000000-0000-4000-8000-000000000006", "personal", null, "Personal", 100, "#6750a4", true),
];

const annotations = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    layerId: layers[0].id,
    version: 1,
    deleted: false,
    payload: {
      kind: "text",
      pageNumber: 1,
      x: 0.5,
      y: 0.2,
      fontScale: 0.024,
      text: "第一排男高音这里请统一提前吸气并保持轻声进入",
    },
    createdByDisplayName: "林老师",
    updatedByDisplayName: "林老师",
    updatedAt: FIXED_TIME,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    layerId: layers[5].id,
    version: 1,
    deleted: false,
    payload: { kind: "text", pageNumber: 1, x: 0.63, y: 0.66, fontScale: 0.024, text: "换气" },
    createdByDisplayName: "周宁",
    updatedByDisplayName: "周宁",
    updatedAt: FIXED_TIME,
  },
];

export function resolveFixtureRequest({
  pathname,
  method = "GET",
  identity = "guest",
  scenarioId = "",
  cookie = "",
  pdf = samplePdf,
  selectedScore = score,
}) {
  const score = selectedScore;
  const samplePdf = pdf;
  if (method === "DELETE" && pathname === "/api/guest/session") {
    return { status: 204, body: "", contentType: "text/plain", headers: { "set-cookie": "same_page_guest=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" } };
  }

  if (method === "GET" && pathname === "/api/auth/social-providers") {
    return json({ providers: ["google", "wechat"] });
  }

  if (method === "GET" && pathname === "/api/auth/get-session") {
    return json(identity === "guest" ? null : session(identity));
  }

  if (method === "GET" && pathname === "/api/guest/session") {
    return cookie.includes("same_page_guest=visual-preview")
      ? json({ choir: previewChoir, entryKind: "preview" })
      : json({ error: "no_guest_session" }, 404);
  }

  if (method === "GET" && pathname === "/api/guest/preview-choir") {
    return json({ choir: previewChoir });
  }

  if (
    method === "GET" &&
    pathname === `/api/guest/choirs/${previewChoir.id}`
  ) {
    return json({ choir: previewChoir, entryKind: "preview" });
  }

  if (method === "GET" && pathname.startsWith("/api/guest/choirs/")) {
    return json({ error: "not_found" }, 404);
  }

  if (method === "POST" && pathname === "/api/guest/session") {
    if (identity === "guest") {
      return json({ error: "invalid_or_expired_join_code" }, 404);
    }
    return {
      ...json({ choir: previewChoir, entryKind: "preview" }),
      headers: {
        "cache-control": "no-store",
        "set-cookie": "same_page_guest=visual-preview; Path=/; HttpOnly; SameSite=Lax",
      },
    };
  }

  if (method === "GET" && pathname === "/api/choirs") {
    return json({
      memberships:
        identity === "guest"
          ? []
          : [
              {
                id: `visual-membership-${identity}`,
                displayName: identity === "admin" ? "林老师" : "周宁",
                role: identity === "admin" ? "admin" : "member",
                choir,
              },
            ],
    });
  }

  if (method === "GET" && pathname === `/api/choirs/${choir.id}/scores`) {
    return json({
      scores: [score, ...otherScores],
      storage: { usedBytes: 1_572_864, limitBytes: 1_073_741_824 },
      permissions: { canManage: identity === "admin" },
    });
  }

  if (method === "GET" && pathname === `/api/choirs/${choir.id}/bootstrap`) {
    return json({
      choir,
      scores: [score, ...otherScores],
      storage: { usedBytes: 1_572_864, limitBytes: 1_073_741_824 },
      permissions: {
        canManage: identity === "admin",
        access: "membership",
      },
    });
  }

  if (
    method === "GET" &&
    pathname === `/api/choirs/${previewChoir.id}/bootstrap` &&
    cookie.includes("same_page_guest=visual-preview")
  ) {
    return json({
      choir: previewChoir,
      scores: [{ ...score, choirId: previewChoir.id }],
      storage: { usedBytes: score.currentVersion.sizeBytes, limitBytes: 1_073_741_824 },
      permissions: { canManage: false, access: "guest" },
    });
  }

  if (
    method === "GET" &&
    pathname === `/api/choirs/${choir.id}/scores/${score.id}/bootstrap`
  ) {
    return json({
      state: "active",
      score,
      permissions: { canManage: identity === "admin" },
    });
  }

  if (
    method === "GET" &&
    pathname === `/api/choirs/${previewChoir.id}/scores` &&
    cookie.includes("same_page_guest=visual-preview")
  ) {
    return json({
      scores: [{ ...score, choirId: previewChoir.id }],
      storage: { usedBytes: score.currentVersion.sizeBytes, limitBytes: 1_073_741_824 },
      permissions: { canManage: false },
    });
  }

  if (
    (method === "GET" || method === "HEAD") &&
    (pathname === `/api/choirs/${choir.id}/scores/${score.id}/pdf` ||
      pathname ===
        `/api/choirs/${choir.id}/scores/${score.id}/versions/${score.currentVersion.id}/pdf`)
  ) {
    return {
      status: 200,
      contentType: "application/pdf",
      body: samplePdf,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "content-length": String(samplePdf.byteLength),
        "x-score-version": score.currentVersion.id,
      },
    };
  }

  if (method === "GET" && pathname === `/api/choirs/${choir.id}/scores/${score.id}/layers`) {
    return json({
      layers: layers.map((entry) => ({
        ...entry,
        ...(entry.defaultSlot === "B"
          ? {
              subscribed: false,
              subscriptionSource: "score",
              driveSubscribed: true,
              scoreSubscriptionOverride: false,
            }
          : {}),
        ...(entry.defaultSlot === "E" && scenarioId.startsWith("reader-edit-unsubscribed")
          ? {
              subscribed: false,
              subscriptionSource: "drive",
              driveSubscribed: false,
              scoreSubscriptionOverride: null,
            }
          : {}),
        canEdit: entry.kind === "personal" || identity === "admin",
      })),
      permissions: { canManageLayers: identity === "admin" },
    });
  }

  if (method === "GET" && pathname === `/api/choirs/${choir.id}/shared-layer-preferences`) {
    return json({
      drive: { id: choir.id, name: choir.name },
      layers: layers.filter((entry) => entry.kind === "shared").map((entry) => ({
        slot: entry.defaultSlot,
        name: entry.name,
        subscribed: entry.defaultSlot !== "B",
        colorOverride: entry.defaultSlot === "E" ? "#7c3aed" : null,
        adminDefaultColor: entry.adminDefaultColor,
        displayColor: entry.defaultSlot === "E" ? "#7c3aed" : entry.displayColor,
        colorSource: entry.defaultSlot === "E" ? "drive" : "admin",
      })),
    });
  }

  if (method === "GET" && pathname === `/api/choirs/${choir.id}/shared-layers`) {
    return json({
      drive: { id: choir.id, name: choir.name },
      layers: layers.filter((entry) => entry.kind === "shared").map((entry, index) => ({
        slot: entry.defaultSlot,
        name: entry.name,
        defaultColor: entry.adminDefaultColor,
        grantedMemberCount: [2, 1, 0, 1, 0][index],
      })),
    });
  }

  if (
    method === "GET" &&
    /^\/api\/choirs\/visual-choir\/shared-layers\/[ESATB]\/grants$/.test(pathname)
  ) {
    return json({
      members: [
        { id: "visual-membership-admin", displayName: "林老师", role: "admin", granted: true },
        { id: "visual-membership-member", displayName: "周宁", role: "member", granted: true },
        { id: "visual-membership-guest", displayName: "陈夏", role: "member", granted: false },
      ],
    });
  }

  if (
    method === "GET" &&
    pathname === `/api/choirs/${choir.id}/scores/${score.id}/annotations`
  ) {
    return json({ cursor: 2, objects: annotations });
  }

  return json({ error: "visual_fixture_not_found", method, pathname }, 404);
}

export const visualFixture = Object.freeze({
  choir,
  previewChoir,
  score,
  samplePdfSha256,
});

function layer(id, kind, defaultSlot, name, sortOrder, defaultColor, canEdit = false) {
  return {
    id,
    kind,
    defaultSlot,
    name,
    sortOrder,
    subscribed: true,
    subscriptionSource: kind === "personal" ? "personal" : "product",
    displayColor: defaultColor,
    colorSource: kind === "personal" ? "personal" : "admin",
    adminDefaultColor: kind === "personal" ? null : defaultColor,
    driveSubscribed: null,
    driveColorOverride: null,
    scoreSubscriptionOverride: null,
    canEdit,
  };
}

function session(identity) {
  const userId = `visual-user-${identity}`;
  const timestamp = new Date(FIXED_TIME).toISOString();
  return {
    session: {
      id: `visual-session-${identity}`,
      token: "visual-report-placeholder-token",
      userId,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: timestamp,
      updatedAt: timestamp,
      ipAddress: null,
      userAgent: "Same Page visual report",
    },
    user: {
      id: userId,
      name: identity === "admin" ? "林老师" : "周宁",
      email: `${identity}@visual.invalid`,
      emailVerified: true,
      image: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function json(body, status = 200) {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(body),
    headers: { "cache-control": "no-store" },
  };
}

function createSampleScorePdf() {
  const pageOne = scorePageContent("SAME PAGE VISUAL FIXTURE", "Rehearsal score - page 1", 1);
  const pageTwo = scorePageContent("SAME PAGE VISUAL FIXTURE", "Rehearsal score - page 2", 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(pageOne)} >>\nstream\n${pageOne}\nendstream`,
    `<< /Length ${Buffer.byteLength(pageTwo)} >>\nstream\n${pageTwo}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  document += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
}

function scorePageContent(title, subtitle, pageNumber) {
  const staffLines = Array.from({ length: 4 }, (_, system) => {
    const startY = 570 - system * 125;
    return Array.from({ length: 5 }, (_, line) => {
      const y = startY - line * 10;
      return `72 ${y} m 540 ${y} l S`;
    }).join("\n");
  }).join("\n");
  const bars = Array.from({ length: 4 }, (_, system) => {
    const top = 570 - system * 125;
    const bottom = top - 40;
    return [72, 188, 306, 424, 540]
      .map((x) => `${x} ${bottom} m ${x} ${top} l S`)
      .join("\n");
  }).join("\n");
  const notes = Array.from({ length: 4 }, (_, system) => {
    const y = 548 - system * 125;
    return [116, 150, 228, 270, 346, 390, 462, 510]
      .map((x, index) => {
        const noteY = y + ((index + system) % 5) * 5;
        return `${pdfEllipse(x, noteY, 4.5, 3.2)} f\n${x + 4.2} ${noteY} m ${x + 4.2} ${noteY + 25} l S`;
      })
      .join("\n");
  }).join("\n");
  return [
    "q",
    "0.985 0.98 0.95 rg 36 36 540 720 re f",
    "0.02 0.27 0.32 rg",
    `BT /F1 24 Tf 72 708 Td (${title}) Tj ET`,
    "0.20 0.22 0.22 rg",
    `BT /F1 13 Tf 72 680 Td (${subtitle}) Tj ET`,
    "0.12 0.18 0.19 RG 0.7 w",
    staffLines,
    "1.1 w",
    bars,
    "0.50 0.15 0.28 rg",
    notes,
    "0.20 0.22 0.22 rg",
    `BT /F1 10 Tf 485 58 Td (Page ${pageNumber} / 2) Tj ET`,
    "Q",
  ].join("\n");
}

function pdfEllipse(x, y, radiusX, radiusY) {
  const kappa = 0.552_284_749_8;
  const controlX = radiusX * kappa;
  const controlY = radiusY * kappa;
  return [
    `${x - radiusX} ${y} m`,
    `${x - radiusX} ${y + controlY} ${x - controlX} ${y + radiusY} ${x} ${y + radiusY} c`,
    `${x + controlX} ${y + radiusY} ${x + radiusX} ${y + controlY} ${x + radiusX} ${y} c`,
    `${x + radiusX} ${y - controlY} ${x + controlX} ${y - radiusY} ${x} ${y - radiusY} c`,
    `${x - controlX} ${y - radiusY} ${x - radiusX} ${y - controlY} ${x - radiusX} ${y} c`,
  ].join("\n");
}

// Original synthetic SATB notation and neutral syllables, authored for this
// repository's UI fixtures. No score, lyric, identity or private data is copied.
export const denseFixtureProvenance = {
  kind: "original-generated",
  source: "visual-report/fixtures.mjs",
  description: "自行生成的 SATB 排版样本，使用原创音符排列与 la / lu / ah 音节；仅用于界面检验，不作为可演唱乐谱。",
  pageSizes: [[612, 792], [595, 842], [842, 595], [612, 792], [595, 842], [612, 792], [842, 595], [612, 792]],
};

export function createVisualFixtureSession(scenario = {}) {
  const requests = [];
  const intentionalFailures = [];
  const unmatchedRequests = [];
  const preferences = new Map();
  const scorePreferences = new Map();
  const colors = new Map();
  const grants = new Map();
  let loadFailures = 0;
  let uploadCount = 0;
  const pdf = scenario.dense ? createDenseScorePdf() : samplePdf;
  const selectedScore = scenario.dense ? {
    ...score,
    fileName: "原创 SATB 排版样本 · 八页混合尺寸.pdf",
    currentVersion: { ...score.currentVersion, pageCount: 8, sizeBytes: pdf.byteLength, sha256: createHash("sha256").update(pdf).digest("hex") },
  } : score;
  let scores = scenario.id === "library-empty" ? [] : [selectedScore, ...otherScores];
  if (scenario.id === "library-long-list") scores = Array.from({ length: 30 }, (_, index) => ({
    ...selectedScore,
    id: index ? `long-score-${index}` : selectedScore.id,
    fileName: `${String(index + 1).padStart(2, "0")} · 秋日合唱排练与正式演出 · 全声部附歌词 · 修订版_${index + 1}_最终校对.pdf`,
  }));
  return {
    pdf,
    diagnostics: { requests, intentionalFailures, unmatchedRequests },
    resolve(request) {
      const { pathname, method = "GET", body } = request;
      requests.push({ method, pathname });
      const failure = (status, reason) => {
        intentionalFailures.push({ method, pathname, status, reason });
        return json({ error: reason }, status);
      };
      if (scenario.id === "preferences-load-retry" && pathname.endsWith("/shared-layer-preferences") && loadFailures++ === 0) return failure(503, "injected_preferences_unavailable");
      if (scenario.id === "preferences-load-failure" && pathname.endsWith("/shared-layer-preferences")) return failure(503, "injected_preferences_unavailable");
      if (scenario.id === "settings-permission-denied" && pathname.includes("/shared-layers")) return failure(403, "forbidden");
      if (scenario.id === "reader-layer-save-failure" && method === "PUT" && pathname.includes("/shared-layers/")) return failure(503, "injected_preference_save_failure");
      if (scenario.id === "reader-offline-failure" && pathname.includes("/versions/") && pathname.endsWith("/pdf")) return failure(503, "injected_pdf_download_failure");
      const slot = pathname.match(/\/shared-layers\/([ESATB])\//)?.[1];
      if (method === "PUT" && slot) {
        if (pathname.endsWith("/preference")) {
          const map = pathname.includes("/scores/") ? scorePreferences : preferences;
          const previous = map.get(slot) ?? (map === preferences ? { subscribed: slot !== "B", colorOverride: slot === "E" ? "#7c3aed" : null } : {});
          map.set(slot, { ...previous, ...body });
          return json({ preference: map.get(slot) });
        }
        if (pathname.endsWith("/settings")) {
          if (request.identity !== "admin") return failure(403, "forbidden");
          colors.set(slot, body.defaultColor);
          return json({ setting: { slot, defaultColor: body.defaultColor } });
        }
        if (pathname.includes("/grants/")) {
          if (request.identity !== "admin") return failure(403, "forbidden");
          const membershipId = pathname.split("/").at(-1);
          grants.set(`${slot}:${membershipId}`, body.granted);
          return json({ grant: { membershipId, granted: body.granted } });
        }
      }
      if (method === "POST" && pathname === `/api/choirs/${choir.id}/scores`) {
        uploadCount += 1;
        if (scenario.id === "library-upload-partial" && uploadCount === 2) return failure(413, "pdf_too_large");
        const uploaded = { ...selectedScore, id: `uploaded-${uploadCount}`, fileName: `已上传示例${uploadCount}.pdf` };
        scores.push(uploaded);
        return json({ score: uploaded }, 201);
      }
      const response = resolveFixtureRequest({ ...request, scenarioId: scenario.id ?? request.scenarioId, pdf, selectedScore });
      if (!response.contentType.startsWith("application/json")) return response;
      const payload = JSON.parse(response.body);
      if (!payload) return response;
      if (payload.error === "visual_fixture_not_found") unmatchedRequests.push({ method, pathname });
      if (payload.scores && !pathname.includes("visual-preview-choir")) payload.scores = scores;
      if (pathname.endsWith("/shared-layer-preferences") && payload.layers) payload.layers = payload.layers.map((entry) => {
        const preference = preferences.get(entry.slot) ?? entry;
        const adminDefaultColor = colors.get(entry.slot) ?? entry.adminDefaultColor;
        return { ...entry, ...preference, adminDefaultColor, displayColor: preference.colorOverride ?? adminDefaultColor, colorSource: preference.colorOverride ? "drive" : "admin" };
      });
      if (pathname.endsWith("/shared-layers") && payload.layers) payload.layers = payload.layers.map((entry) => ({ ...entry, defaultColor: colors.get(entry.slot) ?? entry.defaultColor }));
      if (pathname.endsWith("/grants") && payload.members) payload.members = payload.members.map((member) => ({ ...member, granted: grants.get(`${slot}:${member.id}`) ?? member.granted }));
      if (pathname.endsWith("/layers") && payload.layers) payload.layers = payload.layers.map((entry) => {
        const preference = scorePreferences.get(entry.defaultSlot);
        if (!preference) return entry;
        return { ...entry, subscribed: preference.subscribed ?? entry.driveSubscribed ?? true, scoreSubscriptionOverride: preference.subscribed, subscriptionSource: preference.subscribed === null ? "drive" : "score" };
      });
      return { ...response, body: JSON.stringify(payload) };
    },
  };
}

function createDenseScorePdf() {
  const pages = denseFixtureProvenance.pageSizes;
  const fontId = 3 + pages.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    ...pages.map(([width, height], i) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${3 + pages.length + i} 0 R >>`),
    ...pages.map(([width, height], i) => {
      const content = densePageContent(width, height, i + 1);
      return `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(document)); document += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
}

function densePageContent(width, height, pageNumber) {
  const content = ["0 0 0 rg 0 0 0 RG .45 w", `BT /F1 19 Tf 44 ${height - 42} Td (SATB - ORIGINAL LAYOUT STUDY) Tj ET`, `BT /F1 8 Tf 44 ${height - 59} Td (Synthetic notes and neutral syllables / page ${pageNumber} of 8) Tj ET`];
  const systems = height > 700 ? 3 : 2;
  for (let system = 0; system < systems; system++) {
    const top = height - 98 - system * ((height - 140) / systems);
    for (let voice = 0; voice < 4; voice++) {
      const y = top - voice * 48;
      content.push(`BT /F1 9 Tf 28 ${y - 9} Td (${"SATB"[voice]}) Tj ET`);
      for (let line = 0; line < 5; line++) content.push(`48 ${y - line * 4} m ${width - 32} ${y - line * 4} l S`);
      for (let bar = 0; bar <= 4; bar++) {
        const x = 48 + (width - 80) * bar / 4;
        content.push(`${x} ${y} m ${x} ${y - 16} l S`);
      }
      for (let note = 0; note < 16; note++) {
        const x = 58 + (width - 96) * note / 16;
        const noteY = y - ((note * 3 + voice + pageNumber) % 9) * 2;
        content.push(`${pdfEllipse(x, noteY, 3, 2)} f`, `${x + 2.6} ${noteY} m ${x + 2.6} ${noteY + 16} l S`, `BT /F1 7 Tf ${x - 3} ${y - 31} Td (${["la", "lu", "ah"][note % 3]}) Tj ET`);
      }
    }
  }
  content.push(`BT /F1 9 Tf ${width / 2} 22 Td (${pageNumber}) Tj ET`);
  return content.join("\n");
}
