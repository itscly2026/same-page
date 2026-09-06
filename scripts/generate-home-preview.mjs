// Original generated score, rendered by the actual reader; contains no user data.
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { createSampleScorePdf, resolveFixtureRequest } from "../visual-report/fixtures.mjs";
import { startViteServer } from "./vite-server.mjs";
const app = await startViteServer({ script: "dev" });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 720, height: 920 }, deviceScaleFactor: 1, serviceWorkers: "block" });
  const pdf = createSampleScorePdf("Rehearsal Study");
  await page.addInitScript(() => localStorage.setItem("reader-gesture-hint-seen", "true"));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const response = resolveFixtureRequest({ pathname, method: request.method(), identity: "member", scenarioId: "reader-clean", cookie: "" });
    if (response.contentType === "application/pdf") response.body = pdf;
    if (response.contentType.startsWith("application/json")) {
      const body = JSON.parse(response.body);
      if (body.score) body.score.currentVersion = { ...body.score.currentVersion, sha256: createHash("sha256").update(pdf).digest("hex"), sizeBytes: pdf.byteLength };
      response.body = JSON.stringify(body);
    }
    await route.fulfill(response);
  });
  await page.goto(`${app.origin}/choirs/visual-choir/scores/visual-score`);
  await page.locator("[data-page-turn-current] [data-pdf-canvas-active]").waitFor();
  await page.getByText("换气", { exact: true }).waitFor();
  await page.screenshot({ path: "src/client/assets/home/reader-preview.png" });
} finally { await browser.close(); await app.stop(); }
