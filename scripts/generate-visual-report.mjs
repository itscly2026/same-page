import { execFileSync, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium, devices } from "@playwright/test";

import { resolveFixtureRequest } from "../visual-report/fixtures.mjs";
import {
  createVisualReportManifest,
  renderVisualReportHtml,
} from "../visual-report/report.mjs";
import {
  validateVisualReportScenarios,
  visualReportScenarios,
} from "../visual-report/scenarios.mjs";

const repositoryRoot = process.cwd();
const outputRoot = path.resolve(repositoryRoot, "artifacts/visual-report");
const screenshotsRoot = path.join(outputRoot, "screenshots");
const port = Number.parseInt(process.env.VISUAL_REPORT_PORT ?? "4173", 10);
const baseUrl = `http://127.0.0.1:${port}`;

ensureSafeOutputPath(outputRoot);
validateVisualReportScenarios();
const requestedScenario = process.env.VISUAL_REPORT_SCENARIO;
const scenarios = requestedScenario
  ? visualReportScenarios.filter((scenario) => scenario.id === requestedScenario)
  : visualReportScenarios;
if (requestedScenario && scenarios.length !== 1) {
  throw new Error(`Unknown visual report scenario: ${requestedScenario}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(screenshotsRoot, { recursive: true });

const preview = startPreviewServer(port);
const serverLogs = [];
preview.stdout.on("data", (chunk) => rememberLog(serverLogs, chunk));
preview.stderr.on("data", (chunk) => rememberLog(serverLogs, chunk));

let browser;
try {
  await waitForServer(baseUrl);
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
      serviceWorkers: "block",
      timezoneId: "Asia/Shanghai",
    });
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const response = resolveFixtureRequest({
        pathname: new URL(request.url()).pathname,
        method: request.method(),
        identity: scenario.identity,
        cookie: request.headers()["cookie"] ?? "",
      });
      await route.fulfill(response);
    });
    await context.addInitScript(() => {
      localStorage.setItem("reader-gesture-hint-seen", "true");
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.goto(`${baseUrl}${scenario.route}`, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;caret-color:transparent!important}",
    });
    if (scenario.waitsForPdf) {
      try {
        await waitForRenderedPdf(page);
      } catch (error) {
        if (pageErrors.length > 0) throw pageErrors[0];
        throw error;
      }
    }
    await runActions(page, scenario.actions);
    await waitForReady(page, scenario.ready);
    await waitForPageToSettle(page);
    if (scenario.waitsForPdf) await waitForRenderedPdf(page);
    if (pageErrors.length > 0) throw pageErrors[0];

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
    });
    await context.close();
    process.stdout.write(`Captured ${scenario.id}\n`);
  }

  const manifest = createVisualReportManifest({
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    captures,
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
  if (serverLogs.length > 0) {
    process.stderr.write(`Preview server output:\n${serverLogs.join("")}\n`);
  }
  throw error;
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
}

function ensureSafeOutputPath(target) {
  const relative = path.relative(repositoryRoot, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe visual report output path: ${target}`);
  }
}

function startPreviewServer(previewPort) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawn(
    executable,
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"],
    { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Preview responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not start at ${url}`, { cause: lastError });
}

async function runActions(page, actions) {
  for (const action of actions) {
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

function rememberLog(logs, chunk) {
  logs.push(String(chunk));
  if (logs.length > 40) logs.shift();
}
