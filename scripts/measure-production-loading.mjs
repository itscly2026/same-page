import assert from "node:assert/strict";
import process from "node:process";

import { webkit } from "@playwright/test";

const origin = new URL(process.argv[2] ?? "https://samepage.clyapps.com").origin;
const browser = await webkit.launch({ headless: true });

try {
  const results = [];
  results.push(await measureScenario("clean-web", "block"));
  results.push(await measureScenario("updated-pwa", "allow"));
  process.stdout.write(`${JSON.stringify({ origin, results }, null, 2)}\n`);
} finally {
  await browser.close();
}

async function measureScenario(name, serviceWorkers) {
  const context = await browser.newContext({ locale: "zh-CN", serviceWorkers });
  const requestOrder = [];
  context.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) requestOrder.push(classifyRequest(pathname));
  });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  if (serviceWorkers === "allow") {
    await page.evaluate(async () => {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("service_worker_timeout")), 20_000)),
      ]);
    });
    if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
      await page.reload({ waitUntil: "domcontentloaded" });
    }
  }

  const build = await page.evaluate(async () =>
    fetch("/build.json", { cache: "no-store" }).then((response) => response.json()));
  const initialDiagnostics = await diagnostics(page);
  assert.equal(initialDiagnostics.buildId, build.buildId, `${name}: mixed build assets`);
  if (serviceWorkers === "allow") {
    assert.equal(initialDiagnostics.serviceWorker, "activated", `${name}: inactive worker`);
  }

  await page.getByRole("link", { name: "访问公开体验云盘" }).click();
  await page.locator(".file-list").waitFor({ state: "visible" });
  const entryEnd = requestOrder.length;
  await page.locator("html[data-reader-runtime='ready']").waitFor();

  await openFirstScore(page);
  await returnToCachedDrive(page);
  await openFirstScore(page);
  await context.setOffline(true);
  await returnToCachedDrive(page);
  await page.getByText("暂时无法更新乐谱列表，当前内容已保留。请稍后重试。").waitFor();
  assert.equal(await page.locator(".file-list").isVisible(), true, `${name}: cached list lost offline`);
  await context.setOffline(false);

  const finalDiagnostics = await diagnostics(page);
  assert.equal(finalDiagnostics.buildId, build.buildId, `${name}: build changed during measurement`);
  const journeys = finalDiagnostics.records
    .filter((record) => record.name.endsWith(":duration"))
    .map(({ journey, duration, cacheCategory }) => ({
      journey,
      duration: Math.round(duration * 10) / 10,
      cacheCategory,
    }));
  assert.ok(journeys.some((record) => record.journey === "enter-drive"), `${name}: missing drive entry`);
  assert.ok(journeys.some((record) =>
    record.journey === "open-score" && record.cacheCategory === "cold"), `${name}: missing cold open`);
  assert.ok(journeys.some((record) =>
    record.journey === "open-score" && record.cacheCategory === "reopen"), `${name}: missing reopen`);
  assert.ok(journeys.filter((record) => record.journey === "exit-score").length >= 2,
    `${name}: missing cached exits`);

  const entryRequests = requestOrder.slice(0, entryEnd);
  assert.equal(entryRequests.filter((entry) => entry === "drive-bootstrap").length, 2,
    `${name}: public preview should deny once, admit once, then bootstrap once`);
  assert.equal(entryRequests.includes("score-list"), false, `${name}: duplicate score-list waterfall`);

  const serverTiming = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/api/"))
      .flatMap((entry) => entry.serverTiming.map((timing) => timing.name))
      .filter((value, index, values) => values.indexOf(value) === index));

  await context.close();
  return {
    scenario: name,
    buildId: finalDiagnostics.buildId,
    serviceWorker: finalDiagnostics.serviceWorker,
    displayMode: finalDiagnostics.displayMode,
    journeys,
    requestOrder,
    serverTiming,
    networkFailure: "cached-drive-visible",
  };
}

async function openFirstScore(page) {
  await page.locator(".file-row__open").first().click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
}

async function returnToCachedDrive(page) {
  const completedExits = await page.evaluate(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance().records.filter(
      (record) => record.name === "exit-score:duration",
    ).length ?? 0);
  await page.locator(".page-reader__viewport").click({ position: { x: 250, y: 250 } });
  await page.getByRole("link", { name: "返回云盘", exact: true }).click();
  await page.locator(".file-list").waitFor({ state: "visible" });
  await page.waitForFunction((previousCount) =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance().records.filter(
      (record) => record.name === "exit-score:duration",
    ).length > previousCount, completedExits);
}

async function diagnostics(page) {
  const result = await page.evaluate(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance());
  assert.ok(result, "loading diagnostics are missing");
  return result;
}

function classifyRequest(pathname) {
  if (pathname === "/api/auth/get-session") return "auth-session";
  if (pathname === "/api/choirs") return "drive-memberships";
  if (/\/api\/choirs\/[^/]+\/bootstrap$/.test(pathname)) return "drive-bootstrap";
  if (pathname.endsWith("/bootstrap")) return "score-bootstrap";
  if (pathname.endsWith("/pdf")) return "pdf";
  if (pathname.endsWith("/layers")) return "layers";
  if (pathname.endsWith("/annotations")) return "annotations";
  if (/\/choirs\/[^/]+\/scores$/.test(pathname)) return "score-list";
  if (pathname.startsWith("/api/guest/")) return "guest-session";
  return "other-api";
}
