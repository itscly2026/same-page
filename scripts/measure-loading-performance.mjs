import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";

import { webkit } from "@playwright/test";

import { evaluateLoadingBudget } from "./loading-performance-budget.mjs";
import { resolveFixtureRequest } from "../visual-report/fixtures.mjs";

const port = Number.parseInt(process.env.LOADING_TEST_PORT ?? "4184", 10);
const origin = `http://127.0.0.1:${port}`;
const controlledDelayMs = Number.parseInt(
  process.env.LOADING_TEST_DELAY_MS ?? "75",
  10,
);
const maxDurationMs = Number.parseInt(
  process.env.LOADING_TEST_MAX_MS ?? "15000",
  10,
);
const expectedJourneys = ["enter-drive", "open-score", "exit-score"];
const requestOrder = [];
const preview = startPreviewServer(port);
const serverLogs = [];
preview.stdout.on("data", (chunk) => rememberLog(serverLogs, chunk));
preview.stderr.on("data", (chunk) => rememberLog(serverLogs, chunk));

let browser;
try {
  await waitForServer();
  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({
    locale: "zh-CN",
    serviceWorkers: "block",
  });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    requestOrder.push(classifyRequest(pathname));
    if (controlledDelayMs > 0) await delay(controlledDelayMs);
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
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "进入云盘", exact: true }).click();
  await page.getByRole("link", { name: /示例云盘/ }).click();
  await page.locator(".file-list").waitFor({ state: "visible" });
  await page.locator(".file-row__open").first().click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({
    state: "visible",
  });
  await page.locator(".page-reader__viewport").click({ position: { x: 250, y: 250 } });
  await page.getByRole("link", { name: "返回云盘", exact: true }).click();
  await page.locator(".file-list").waitFor({ state: "visible" });

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
  const regressions = evaluateLoadingBudget(journeys, Object.fromEntries(
    expectedJourneys.map((journey) => [journey, maxDurationMs]),
  ));
  assert.deepEqual(regressions, [], `loading budget exceeded: ${JSON.stringify(regressions)}`);

  process.stdout.write(`${JSON.stringify({
    buildId: diagnostics.buildId,
    scenario: "controlled-desktop",
    controlledDelayMs,
    displayMode: diagnostics.displayMode,
    serviceWorker: diagnostics.serviceWorker,
    journeys,
    requestOrder,
  }, null, 2)}\n`);
  await context.close();
} catch (error) {
  if (serverLogs.length > 0) {
    process.stderr.write(`Preview server output:\n${serverLogs.join("")}\n`);
  }
  throw error;
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
}

function startPreviewServer(previewPort) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawn(
    executable,
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"],
    { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
      lastError = new Error(`Preview responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error("Preview server did not start", { cause: lastError });
}

function classifyRequest(pathname) {
  if (pathname === "/api/auth/get-session") return "auth-session";
  if (pathname === "/api/choirs") return "drive-memberships";
  if (pathname.endsWith("/bootstrap")) return "score-bootstrap";
  if (pathname.endsWith("/pdf")) return "pdf";
  if (pathname.endsWith("/layers")) return "layers";
  if (pathname.endsWith("/annotations")) return "annotations";
  if (/\/choirs\/[^/]+\/scores$/.test(pathname)) return "score-list";
  if (pathname.startsWith("/api/guest/")) return "guest-session";
  return "other-api";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function rememberLog(logs, chunk) {
  logs.push(String(chunk));
  if (logs.length > 40) logs.shift();
}
