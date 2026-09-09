import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium, devices } from "@playwright/test";

import { createVisualFixtureSession, denseFixtureProvenance } from "../visual-report/fixtures.mjs";
import {
  createVisualReportManifest,
  renderVisualReportHtml,
} from "../visual-report/report.mjs";
import {
  validateVisualReportScenarios,
  visualReportScenarios,
} from "../visual-report/scenarios.mjs";
import { startViteServer } from "./vite-server.mjs";

const repositoryRoot = process.cwd();
const outputRoot = path.resolve(repositoryRoot, "artifacts/visual-report");
const screenshotsRoot = path.join(outputRoot, "screenshots");
const port = process.env.VISUAL_REPORT_PORT ? Number(process.env.VISUAL_REPORT_PORT) : undefined;

ensureSafeOutputPath(outputRoot);
validateVisualReportScenarios();
const requestedScenario = process.env.VISUAL_REPORT_SCENARIO;
const requestedIds = requestedScenario?.split(",");
const fromIndex = process.env.VISUAL_REPORT_FROM ? visualReportScenarios.findIndex((scenario) => scenario.id === process.env.VISUAL_REPORT_FROM) : 0;
if (fromIndex < 0) throw new Error("Unknown VISUAL_REPORT_FROM");
const scenarios = requestedIds
  ? visualReportScenarios.filter((scenario) => requestedIds.includes(scenario.id))
  : visualReportScenarios.slice(fromIndex);
if (requestedIds && scenarios.length !== requestedIds.length) {
  throw new Error(`Unknown visual report scenario: ${requestedScenario}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(screenshotsRoot, { recursive: true });

const preview = await startViteServer({ script: "preview", port, cwd: repositoryRoot });
const baseUrl = preview.origin;

let browser;
let activeCapture;
try {
  browser = await chromium.launch({ headless: true });
  const captures = [];

  for (const scenario of scenarios) {
    const deviceName = scenario.device === "desktop"
      ? "Desktop 1440 × 1000"
      : scenario.device === "landscape"
        ? "iPad Pro 11 landscape"
        : scenario.device === "narrow"
          ? "iPhone 13"
          : "iPad Pro 11";
    const device = scenario.device === "desktop"
      ? { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 }
      : devices[deviceName];
    const context = await browser.newContext({
      ...device,
      colorScheme: "light",
      locale: "zh-CN",
      reducedMotion: "reduce",
      serviceWorkers: "allow",
      timezoneId: "Asia/Shanghai",
    });
    const fixture = createVisualFixtureSession(scenario);
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const response = fixture.resolve({
        pathname: new URL(request.url()).pathname,
        method: request.method(),
        identity: scenario.identity,
        scenarioId: scenario.id,
        cookie: request.headers()["cookie"] ?? "",
        body: request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null,
      });
      await route.fulfill(response);
    });
    await context.addInitScript(() => {
      localStorage.setItem("reader-gesture-hint-seen", "true");
      localStorage.setItem("reader-edit-hint-seen", "true");
    });

    if (scenario.seedContinue) await context.addInitScript(() => {
      localStorage.setItem('same-page:recent-scores:["user:visual-user-member","visual-choir"]', JSON.stringify({ "visual-score": Date.now() }));
      localStorage.setItem("reader-preferences:visual-user-member:visual-choir:visual-score", JSON.stringify({ layout: "page", page: 2 }));
    });

    if (scenario.pwa === "failure" || scenario.pwa === "retry") {
      await context.addInitScript(() => {
        const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        let calls = 0;
        navigator.serviceWorker.register = (...args) => {
          calls += 1;
          window.visualRegistrationAttempts = calls;
          return calls === 1 ? Promise.reject(new Error("visual_injected_registration_failure")) : original(...args);
        };
      });
    }
    const page = await context.newPage();
    activeCapture = { scenario, page, fixture };
    const pageErrors = [];
    const assetFailures = [];
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (!pathname.startsWith("/api/") && response.status() >= 400) assetFailures.push({ pathname, status: response.status() });
    });
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(`${baseUrl}${scenario.route}`, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important}",
    });
    if (scenario.waitsForPdf) {
      try {
        await waitForRenderedPdf(page);
        await page.getByText("换气", { exact: true }).first().waitFor({ state: "visible" });
        if (!scenario.id.startsWith("reader-edit-unsubscribed")) await page.getByText("第一排男高音这里请统一提前吸气并保持轻声进入", { exact: true }).first().waitFor({ state: "visible" });
      } catch (error) {
        if (pageErrors.length > 0) throw pageErrors[0];
        throw error;
      }
    }
    await runActions(page, scenario.actions, fixture);
    await waitForReady(page, scenario.ready);
    await waitForPageToSettle(page);
    if (scenario.waitsForPdf) await waitForRenderedPdf(page);
    await assertScenarioContent(page, scenario);
    if (scenario.pwa !== "failure") {
      await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
      await page.locator(".update-prompt").waitFor({ state: "hidden" });
    }
    if (pageErrors.length > 0) throw pageErrors[0];
    if (assetFailures.length) throw new Error(`Unexpected asset failures: ${JSON.stringify(assetFailures)}`);
    if (fixture.diagnostics.unmatchedRequests.length) throw new Error(JSON.stringify(fixture.diagnostics.unmatchedRequests));

    const screenshotName = `${String(captures.length + 1).padStart(2, "0")}-${scenario.id}.png`;
    const screenshotPath = path.join(screenshotsRoot, screenshotName);
    const screenshot = await page.screenshot({
      path: screenshotPath,
      animations: "disabled",
      fullPage: false,
    });
    const viewport = page.viewportSize();
    captures.push({
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      route: scenario.route,
      identity: scenario.identity,
      device: scenario.device,
      deviceLabel: deviceName,
      viewport,
      pixels: readPngDimensions(screenshot),
      screenshot: `screenshots/${screenshotName}`,
      expectedReady: scenario.ready,
      fixture: scenario.dense ? denseFixtureProvenance : { kind: "original-generated", source: "visual-report/fixtures.mjs" },
      pwa: scenario.pwa ?? "normal-real-registration",
      diagnostics: { ...fixture.diagnostics, assetFailures, pageErrors: [], registrationAttempts: await page.evaluate(() => window.visualRegistrationAttempts ?? null) },
    });
    await context.close();
    process.stdout.write(`Captured ${scenario.id}\n`);
  }

  const manifest = createVisualReportManifest({
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    captures,
    workingTreeDirty: Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()),
  });
  await writeFile(
    path.join(outputRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputRoot, "index.html"),
    renderVisualReportHtml(manifest),
    "utf8",
  );
  process.stdout.write(`Visual report: ${path.join(outputRoot, "index.html")}\n`);
} catch (error) {
  if (activeCapture) {
    const { page, scenario, fixture } = activeCapture;
    await page.screenshot({ path: path.join(outputRoot, `failed-${scenario.id}.png`) }).catch(() => {});
    await writeFile(path.join(outputRoot, "failure.json"), JSON.stringify({ scenario: scenario.id, error: String(error), diagnostics: fixture.diagnostics }, null, 2));
  }
  if (preview.logs.length > 0) {
    process.stderr.write(`Preview server output:\n${preview.logs.join("")}\n`);
  }
  throw error;
} finally {
  await browser?.close();
  await preview.stop();
}

function ensureSafeOutputPath(target) {
  const relative = path.relative(repositoryRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe visual report output path: ${target}`);
  }
}

async function runActions(page, actions, fixture) {
  for (const action of actions) {
    if (action.type === "armFailures") { fixture.armFailures(); continue; }
    if (action.type === "reload") { await page.reload({ waitUntil: "domcontentloaded" }); continue; }
    if (action.type === "waitText") { await page.getByText(action.text, { exact: true }).waitFor({ state: "visible" }); continue; }
    if (action.type === "scrollIntoView") { await page.locator(action.selector).scrollIntoViewIfNeeded(); continue; }
    if (action.type === "uploadSamples") {
      await page.locator('input[type="file"]').setInputFiles([
        { name: "已上传示例1", mimeType: "application/pdf", buffer: fixture.pdf },
        { name: "示例失败", mimeType: "application/pdf", buffer: fixture.pdf },
      ]);
      continue;
    }
    if (action.type === "clickRole") {
      await page.getByRole(action.role, { name: action.name, exact: true }).click();
      continue;
    }
    if (action.type === "fillRole") {
      await page.getByRole(action.role, { name: action.name, exact: true }).fill(action.value);
      continue;
    }
    if (action.type === "assertHidden") {
      await page.locator(action.selector).waitFor({ state: "hidden" });
      continue;
    }
    if (action.type === "clickCenter") {
      const locator = page.locator(action.selector);
      const box = await locator.boundingBox();
      if (!box) throw new Error(`Cannot click hidden visual report target: ${action.selector}`);
      await locator.click({ position: { x: box.width / 2, y: box.height / 2 } });
      continue;
    }
    if (action.type === "fillLabel") {
      await page.getByLabel(action.label, { exact: true }).fill(action.value);
      continue;
    }
    if (action.type === "waitVisible") {
      await page.locator(action.selector).waitFor({ state: "visible" });
      continue;
    }
    if (action.type === "dispatchPointer") {
      await page.locator(action.selector).evaluate((element, point) => {
        const bounds = element.getBoundingClientRect();
        element.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: bounds.left + bounds.width * point.x,
          clientY: bounds.top + bounds.height * point.y,
        }));
      }, { x: action.x, y: action.y });
      continue;
    }
    if (action.type === "dispatchPointerTap") {
      await page.locator(action.selector).evaluate((element, point) => {
        const bounds = element.getBoundingClientRect();
        const eventInit = {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: bounds.left + bounds.width * point.x,
          clientY: bounds.top + bounds.height * point.y,
        };
        element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
        element.dispatchEvent(new PointerEvent("pointerup", eventInit));
      }, { x: action.x, y: action.y });
      continue;
    }
    if (action.type === "dispatchPointerMove") {
      await page.locator(action.selector).evaluate((element, point) => {
        const bounds = element.getBoundingClientRect();
        element.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: bounds.left + bounds.width * point.x,
          clientY: bounds.top + bounds.height * point.y,
        }));
      }, { x: action.x, y: action.y });
      continue;
    }
    if (action.type === "dispatchPointerHalfPage") {
      await page.locator(action.selector).evaluate((element, pageSelector) => {
        const bounds = element.getBoundingClientRect();
        const paperWindow = document.querySelector(pageSelector);
        if (!(paperWindow instanceof HTMLElement)) {
          throw new Error(`Cannot find page-turn window: ${pageSelector}`);
        }
        const paperBounds = paperWindow.getBoundingClientRect();
        const startX = bounds.left + bounds.width * 0.65;
        const common = {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientY: bounds.top + bounds.height / 2,
        };
        element.dispatchEvent(new PointerEvent("pointerdown", {
          ...common,
          clientX: startX,
        }));
        element.dispatchEvent(new PointerEvent("pointermove", {
          ...common,
          clientX: startX - paperBounds.width / 2,
        }));
      }, action.pageSelector);
      continue;
    }
    if (action.type === "dispatchDragRoleToBottom") {
      const locator = page.getByRole(action.role, { name: action.name, exact: true });
      await locator.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const common = {
          bubbles: true,
          pointerId: 1,
          pointerType: "touch",
          clientX: bounds.left + bounds.width / 2,
        };
        element.dispatchEvent(new PointerEvent("pointerdown", {
          ...common,
          clientY: bounds.top + bounds.height / 2,
        }));
        element.dispatchEvent(new PointerEvent("pointermove", {
          ...common,
          clientX: window.innerWidth / 2,
          clientY: window.innerHeight - 32,
        }));
      });
      continue;
    }
    throw new Error(`Unknown visual report action: ${action.type}`);
  }
}

async function waitForReady(page, ready) {
  const locator =
    ready.type === "role"
      ? page.getByRole(ready.role, { name: ready.name, exact: true })
      : ready.type === "text"
        ? page.getByText(ready.text, { exact: true })
        : page.locator(ready.selector);
  await locator.waitFor({ state: "visible" });
}

async function waitForPageToSettle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function waitForRenderedPdf(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".page-reader__sheet[data-page-turn-current] .pdf-page-canvas [data-pdf-canvas-active], .continuous-reader .pdf-page-canvas [data-pdf-canvas-active]",
    );
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 100 || canvas.height < 100) {
      return false;
    }
    const context = canvas.getContext("2d");
    if (!context) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const step = Math.max(4, Math.floor(pixels.length / 4000 / 4) * 4);
    for (let index = 0; index < pixels.length; index += step) {
      if (pixels[index] < 235 || pixels[index + 1] < 235 || pixels[index + 2] < 235) {
        return true;
      }
    }
    return false;
  });
}

function readPngDimensions(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("Playwright returned a non-PNG screenshot");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gitCommit() {
  return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

async function assertScenarioContent(page, scenario) {
  if (!scenario.waitsForPdf) return;
  if (scenario.id.includes("layers") || scenario.id === "reader-layer-save-failure") {
    await page.locator(".reader-layer-panel .layer-card").first().waitFor({ state: "attached" });
    if (await page.locator(".reader-layer-panel .layer-card").count() !== 6) throw new Error("Expected ESATB and Personal layer rows");
  }
  const editing = await page.locator('.reader-icon-button[aria-label="编辑"][aria-pressed="true"]').count() > 0;
  const deleteDrag = scenario.id === "reader-text-delete";
  if (scenario.id === "reader-layer-save-failure" && await page.getByRole("checkbox", { name: "显示 Ensemble", exact: true }).isChecked()) throw new Error("Failed layer save did not preserve the latest local choice");
  if (editing && !deleteDrag) {
    await page.locator(".reader-edit-layer-trigger").waitFor({ state: "visible" });
    for (const name of ["文本", "画笔", "整条橡皮", "撤销", "重做"]) {
      const button = page.locator(`button[aria-label="${name}"]`);
      await button.waitFor({ state: "visible" });
      const box = await button.boundingBox();
      const viewport = page.viewportSize();
      if (!box || box.x < 0 || box.x + box.width > viewport.width + 1) throw new Error("Editing tool clipped: " + name);
    }
  }
  if (scenario.expectedAnnotation !== false && !scenario.id.includes("compose") && !deleteDrag && !scenario.id.includes("dense-pages")) {
    const sharedOnly = scenario.id === "reader-edit-shared-layer" || scenario.id === "reader-edit-unsubscribed-layer";
    const expected = sharedOnly ? "第一排男高音这里请统一提前吸气并保持轻声进入" : "换气";
    await page.getByText(expected, { exact: true }).first().waitFor({ state: "visible" });
  }
}
