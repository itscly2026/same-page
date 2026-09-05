import assert from "node:assert/strict";
import process from "node:process";

import { webkit } from "@playwright/test";
import { classifyPerformanceRequest } from "./loading-performance-report.mjs";
import { startViteServer } from "./vite-server.mjs";

import { evaluateLoadingBudget } from "./loading-performance-budget.mjs";
import { resolveFixtureRequest } from "../visual-report/fixtures.mjs";

const port = process.env.LOADING_TEST_PORT ? Number(process.env.LOADING_TEST_PORT) : undefined;
const controlledDelayMs = Number.parseInt(
  process.env.LOADING_TEST_DELAY_MS ?? "75",
  10,
);
const returnDelayMs = Number.parseInt(
  process.env.LOADING_TEST_RETURN_DELAY_MS ?? "5000",
  10,
);
const maxDurationMs = Number.parseInt(
  process.env.LOADING_TEST_MAX_MS ?? "15000",
  10,
);
const expectedJourneys = ["enter-drive", "open-score", "exit-score"];
const requestOrder = [];
let returningToDrive = false;
const preview = await startViteServer({ script: "preview", port });
const origin = preview.origin;

let browser;
try {
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requestOrder.push(classifyPerformanceRequest(pathname));
    const requestDelay = returningToDrive ? returnDelayMs : controlledDelayMs;
    if (requestDelay > 0) await delay(requestDelay);
    await route.fulfill(resolveFixtureRequest({
      pathname,
      method: request.method(),
      identity: "member",
      cookie: request.headers().cookie ?? "",
    }));
  });
  await context.addInitScript(() => {
    localStorage.setItem("reader-gesture-hint-seen", "true");
  });

  const page = await context.newPage();
  const pdfWorkerPrepared = page.waitForResponse((response) =>
    /\/assets\/pdf\.worker-.*\.mjs$/.test(new URL(response.url()).pathname),
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  // A single confirmed membership enters directly from the default route.
  await page.waitForURL(`${origin}/choirs/visual-choir`);
  await page.locator(".file-list").waitFor({ state: "visible" });
  const enterRequests = [...requestOrder];
  assert.equal(
    enterRequests.filter((request) => request === "drive-bootstrap").length,
    1,
    `drive entry should use one bootstrap: ${JSON.stringify(enterRequests)}`,
  );
  assert.equal(
    enterRequests.filter((request) => request === "score-list").length,
    0,
    `drive entry should not repeat the score list: ${JSON.stringify(enterRequests)}`,
  );
  await page.locator("html[data-reader-runtime='ready']").waitFor();
  await pdfWorkerPrepared;
  await page.locator('.file-row__open[href="/choirs/visual-choir/scores/visual-score"]').click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({
    state: "visible",
  });
  await page.locator(".page-reader__viewport").click({ position: { x: 250, y: 250 } });
  returningToDrive = true;
  await page.getByRole("link", { name: "返回云盘", exact: true }).click();
  await page.locator(".file-list").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance().records.some(
      (record) => record.name === "exit-score:duration",
    ));
  await page.locator('.file-row__open[href="/choirs/visual-choir/scores/visual-score"]').click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({
    state: "visible",
  });
  await page.waitForFunction(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance().records.filter(
      (record) => record.name === "open-score:duration",
    ).length >= 2);

  const diagnostics = await page.evaluate(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance());
  assert.ok(diagnostics, "loading diagnostics are missing");
  const build = await fetch(`${origin}/build.json`).then((response) => response.json());
  assert.equal(
    diagnostics.buildId,
    build.buildId,
    "refusing to measure a page whose build does not match the active assets",
  );

  const journeys = diagnostics.records
    .filter((record) => record.name.endsWith(":duration"))
    .map(({ journey, duration, cacheCategory }) => ({
      journey,
      duration: Math.round(duration * 10) / 10,
      cacheCategory,
    }));
  for (const journey of expectedJourneys) {
    assert.ok(
      journeys.some((record) => record.journey === journey),
      `missing ${journey} measurement`,
    );
  }
  const exitDuration = journeys.find((record) => record.journey === "exit-score")?.duration;
  assert.ok(
    typeof exitDuration === "number" && exitDuration <= 200,
    `cached drive return exceeded 200ms: ${exitDuration}`,
  );
  const coldOpen = journeys.find((record) =>
    record.journey === "open-score" && record.cacheCategory === "cold")?.duration;
  const reopen = journeys.find((record) =>
    record.journey === "open-score" && record.cacheCategory === "reopen")?.duration;
  assert.ok(
    typeof coldOpen === "number" && typeof reopen === "number" && reopen <= coldOpen,
    `reader reopen regressed: cold=${coldOpen}, reopen=${reopen}`,
  );
  const regressions = evaluateLoadingBudget(journeys, Object.fromEntries(
    expectedJourneys.map((journey) => [journey, maxDurationMs]),
  ));
  assert.deepEqual(regressions, [], `loading budget exceeded: ${JSON.stringify(regressions)}`);

  process.stdout.write(`${JSON.stringify({
    buildId: diagnostics.buildId,
    scenario: "controlled-desktop",
    controlledDelayMs,
    returnDelayMs,
    displayMode: diagnostics.displayMode,
    serviceWorker: diagnostics.serviceWorker,
    journeys,
    requestOrder,
  }, null, 2)}\n`);
  await context.close();
} catch (error) {
  if (preview.logs.length > 0) {
    process.stderr.write(`Preview server output:\n${preview.logs.join("")}\n`);
  }
  throw error;
} finally {
  await browser?.close();
  await preview.stop();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
