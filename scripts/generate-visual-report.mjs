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

  for (const scenario of visualReportScenarios) {
    const deviceName =
      scenario.device === "landscape" ? "iPad Pro 11 landscape" : "iPad Pro 11";
    const device = devices[deviceName];
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
    if (action.type === "clickCenter") {
      const locator = page.locator(action.selector);
      const box = await locator.boundingBox();
      if (!box) throw new Error(`Cannot click hidden visual report target: ${action.selector}`);
      await locator.click({ position: { x: box.width / 2, y: box.height / 2 } });
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
    const canvas = document.querySelector(".pdf-page-canvas canvas");
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
