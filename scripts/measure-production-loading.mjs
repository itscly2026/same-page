import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { webkit } from "@playwright/test";

import {
  classifyPerformanceRequest,
  summarizeJourneySamples,
} from "./loading-performance-report.mjs";

const origin = new URL(process.argv[2] ?? "https://samepage.clyapps.com").origin;
const options = parseOptions(process.argv.slice(3));
const rounds = Number(process.env.SAME_PAGE_PERFORMANCE_ROUNDS ?? "3");
assert.ok(Number.isInteger(rounds) && rounds >= 2, "at least two production samples are required");
assert.ok(options.pwaProfile, "--pwa-profile is required for a real cross-deployment update");
assert.ok(options.pwaEvidence, "--pwa-evidence is required for a real cross-deployment update");

const cleanWeb = await measureCleanWeb();
const updatedPwa = await measureUpdatedPwa();
process.stdout.write(`${JSON.stringify({ origin, rounds, results: [cleanWeb, updatedPwa] }, null, 2)}\n`);

async function measureCleanWeb() {
  const browser = await webkit.launch({ headless: true });
  try {
    const context = await browser.newContext({ locale: "zh-CN", serviceWorkers: "block" });
    try {
      return await measureScenario(context, "clean-web");
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function measureUpdatedPwa() {
  const priorEvidence = JSON.parse(await readFile(options.pwaEvidence, "utf8"));
  assert.equal(priorEvidence.origin, origin, "PWA evidence belongs to another origin");
  assert.ok(priorEvidence.documentAssets?.length > 0, "PWA evidence has no prior assets");
  const context = await webkit.launchPersistentContext(options.pwaProfile, {
    headless: true,
    locale: "zh-CN",
    serviceWorkers: "allow",
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const oldAssetsStillCached = await page.evaluate(async (assetPaths) => {
      const results = await Promise.all(assetPaths.map((path) => caches.match(path)));
      return results.every(Boolean);
    }, priorEvidence.documentAssets);
    assert.equal(oldAssetsStillCached, true, "prepared PWA no longer contains the prior production assets");

    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error("service_worker_registration_missing");
      await registration.update();
    });
    await page.getByText("有新版本可用", { exact: true }).waitFor({ timeout: 30_000 });
    await Promise.all([
      page.waitForEvent("domcontentloaded"),
      page.getByRole("button", { name: "更新", exact: true }).click(),
    ]);
    const activeBuild = await readActiveBuild(page);
    const activeAssets = await documentAssets(page);
    assert.ok(
      activeAssets.some((asset) => !priorEvidence.documentAssets.includes(asset)),
      "PWA handover did not load the deployed asset set",
    );

    const result = await measureScenario(context, "updated-pwa", page);
    return {
      ...result,
      updateHandover: {
        priorBuildId: priorEvidence.buildId,
        activeBuildId: activeBuild.buildId,
        oldAssetsWereCached: oldAssetsStillCached,
        userConfirmed: true,
        controllerState: result.serviceWorker,
      },
    };
  } finally {
    await context.close();
  }
}

async function measureScenario(context, name, existingPage) {
  const requestOrder = [];
  context.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) {
      requestOrder.push(classifyPerformanceRequest(pathname));
    }
  });
  const page = existingPage ?? await context.newPage();
  const journeySamples = [];
  const roundsReport = [];
  let activeBuildId;
  let networkFailure = "not-run";

  for (let round = 0; round < rounds; round += 1) {
    if (round > 0 || !existingPage) {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
    }
    const build = await readActiveBuild(page);
    activeBuildId ??= build.buildId;
    assert.equal(build.buildId, activeBuildId, `${name}: build changed between samples`);
    const requestStart = requestOrder.length;

    await page.getByRole("link", { name: "访问公开体验云盘" }).click();
    await page.locator(".file-list").waitFor({ state: "visible" });
    const entryEnd = requestOrder.length;
    await page.locator("html[data-reader-runtime='ready']").waitFor();

    await openScore(page, 0);
    await returnToCachedDrive(page);
    await openScore(page);
    await returnToCachedDrive(page);
    await page.waitForTimeout(15_250);
    await openScore(page);
    if (round === rounds - 1) {
      await context.setOffline(true);
      await returnToCachedDrive(page);
      await page.getByText("暂时无法更新乐谱列表，当前内容已保留。请稍后重试。").waitFor();
      assert.equal(await page.locator(".file-list").isVisible(), true, `${name}: cached list lost offline`);
      await context.setOffline(false);
      networkFailure = "cached-drive-visible";
    } else {
      await returnToCachedDrive(page);
    }

    const finalDiagnostics = await diagnostics(page);
    assert.equal(finalDiagnostics.buildId, activeBuildId, `${name}: mixed build assets`);
    const samples = finalDiagnostics.records
      .filter((record) => record.name.endsWith(":duration"))
      .map(({ journey, duration, cacheCategory }) => ({ journey, duration, cacheCategory }));
    assertRequiredJourneyEvidence(samples, finalDiagnostics.records, name, round);
    journeySamples.push(...samples);

    const entryRequests = requestOrder.slice(requestStart, entryEnd);
    const expectedBootstraps = round === 0 ? [1, 2] : [1];
    assert.ok(
      expectedBootstraps.includes(entryRequests.filter((entry) => entry === "drive-bootstrap").length),
      `${name}: drive entry contains a duplicate bootstrap waterfall`,
    );
    assert.equal(entryRequests.includes("score-list"), false, `${name}: duplicate score-list waterfall`);
    roundsReport.push({
      round: round + 1,
      requests: requestOrder.slice(requestStart),
      journeys: samples.map(roundJourney),
    });
  }

  const finalDiagnostics = await diagnostics(page);
  const serverTiming = await page.evaluate(() =>
    performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/api/"))
      .flatMap((entry) => entry.serverTiming.map((timing) => timing.name))
      .filter((value, index, values) => values.indexOf(value) === index));
  return {
    scenario: name,
    buildId: activeBuildId,
    serviceWorker: finalDiagnostics.serviceWorker,
    displayMode: finalDiagnostics.displayMode,
    journeySummary: summarizeJourneySamples(journeySamples),
    rounds: roundsReport,
    serverTiming,
    networkFailure,
  };
}

function assertRequiredJourneyEvidence(samples, records, name, round) {
  for (const category of ["cold", "warm", "reopen"]) {
    assert.ok(samples.some((record) =>
      record.journey === "open-score" && record.cacheCategory === category),
    `${name} round ${round + 1}: missing ${category} open`);
  }
  assert.ok(samples.some((record) => record.journey === "enter-drive"),
    `${name} round ${round + 1}: missing drive entry`);
  assert.ok(samples.filter((record) => record.journey === "exit-score").length >= 3,
    `${name} round ${round + 1}: missing cached exits`);
  for (const journey of ["enter-drive", "open-score", "exit-score"]) {
    assert.ok(records.some((record) =>
      record.name === "route-transition-committed" && record.journey === journey),
    `${name} round ${round + 1}: missing ${journey} route transition`);
  }
}

async function openScore(page, index = 0) {
  const links = page.locator(".file-row__open");
  assert.ok(await links.count() > index, "public performance fixture has no score");
  await links.nth(index).click();
  await page.locator("canvas[data-pdf-canvas-active]").first().waitFor({ state: "visible" });
}

async function returnToCachedDrive(page) {
  const completedExits = await page.evaluate(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance().records.filter(
      (record) => record.name === "exit-score:duration",
    ).length ?? 0);
  await page.locator(".page-reader__viewport").click({ position: { x: 250, y: 250 } });
  await page.getByRole("link", { name: "返回云盘", exact: true }).click();
  try {
    await page.locator(".file-list").waitFor({ state: "visible" });
  } catch (error) {
    const state = await page.evaluate(() => {
      const text = document.body.innerText;
      if (text.includes("正在打开云盘")) return "route-loading";
      if (text.includes("正在加载乐谱")) return "library-loading";
      if (text.includes("暂时无法打开云盘")) return "drive-failed";
      if (text.includes("无法打开这个云盘")) return "drive-denied";
      if (text.includes("这个云盘不存在")) return "drive-not-found";
      return "unknown";
    });
    throw new Error(`cached drive did not become visible: ${state}`, { cause: error });
  }
  await page.waitForFunction((previousCount) =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance().records.filter(
      (record) => record.name === "exit-score:duration",
    ).length > previousCount, completedExits);
}

async function readActiveBuild(page) {
  const build = await page.evaluate(async () =>
    fetch("/build.json", { cache: "no-store" }).then((response) => response.json()));
  const currentDiagnostics = await diagnostics(page);
  assert.equal(currentDiagnostics.buildId, build.buildId, "page and deployment builds differ");
  return build;
}

async function diagnostics(page) {
  const result = await page.evaluate(() =>
    window.__SAME_PAGE_DIAGNOSTICS__?.loadingPerformance());
  assert.ok(result, "loading diagnostics are missing");
  return result;
}

async function documentAssets(page) {
  return page.evaluate(() => [...document.querySelectorAll("script[src],link[rel='stylesheet']")]
    .map((element) => new URL(element.getAttribute("src") ?? element.getAttribute("href") ?? "", location.origin).pathname)
    .filter((pathname) => pathname.startsWith("/assets/")));
}

function roundJourney({ journey, duration, cacheCategory }) {
  return { journey, duration: Math.round(duration * 10) / 10, cacheCategory };
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === "--pwa-profile") parsed.pwaProfile = value;
    else if (key === "--pwa-evidence") parsed.pwaEvidence = value;
    else throw new Error(`unknown option: ${key}`);
  }
  return parsed;
}
