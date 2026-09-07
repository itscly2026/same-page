import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { webkit } from "@playwright/test";

const repositoryRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "same-page-pwa-update-"));
const builds = {
  first: path.join(temporaryRoot, "first"),
  second: path.join(temporaryRoot, "second"),
};
const buildIds = {
  first: "pwa-e2e-first",
  second: "pwa-e2e-second",
};

let activeBuild = builds.first;
let browser;
let server;

try {
  await buildVersion(buildIds.first, builds.first);
  await buildVersion(buildIds.second, builds.second);

  server = createServer((request, response) => {
    void serveRequest(request, response, activeBuild);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.buildId === expected,
    buildIds.first,
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  const editingWindow = await context.newPage();
  await editingWindow.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
  await editingWindow.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  activeBuild = builds.second;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
  });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  // A second window with an unfinished login form vetoes every candidate page.
  await page.waitForTimeout(5000);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.buildId), buildIds.first);
  assert.equal(await editingWindow.evaluate(() => document.documentElement.dataset.buildId), buildIds.first);
  assert.equal(await page.getByText("有新版本可用", { exact: true }).count(), 0);
  await editingWindow.close();
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.buildId === expected,
    buildIds.second,
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.buildId),
    buildIds.second,
  );
  assert.equal(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    true,
  );

  await context.close();
  process.stdout.write("Verified real Service Worker update handover\n");
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function buildVersion(buildId, destination) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(executable, ["run", "build"], {
    cwd: repositoryRoot,
    env: { ...process.env, SAME_PAGE_BUILD_ID: buildId },
    stdio: "pipe",
  });
  await cp(path.join(repositoryRoot, "dist/client"), destination, {
    recursive: true,
  });
}

async function serveRequest(request, response, root) {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname.startsWith("/api/")) {
      serveApi(requestUrl.pathname, response);
      return;
    }

    const requestedPath = requestUrl.pathname === "/"
      ? "index.html"
      : requestUrl.pathname.slice(1);
    let filePath = safeAssetPath(root, requestedPath);
    try {
      if (!(await stat(filePath)).isFile()) throw new Error("not a file");
    } catch {
      filePath = path.join(root, "index.html");
    }
    const extension = path.extname(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(extension));
    response.setHeader(
      "Cache-Control",
      requestedPath.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.statusCode = 500;
    response.end(error instanceof Error ? error.message : "server error");
  }
}

function safeAssetPath(root, requestedPath) {
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Unsafe asset path");
  }
  return resolved;
}

function serveApi(pathname, response) {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  if (pathname === "/api/auth/get-session") {
    response.end("null");
    return;
  }
  if (pathname === "/api/auth/social-providers") {
    response.end('{"providers":[]}');
    return;
  }
  if (pathname === "/api/guest/preview-choir") {
    response.end('{"error":"not_found"}');
    return;
  }
  response.statusCode = 404;
  response.end('{"error":"not_found"}');
}

function contentType(extension) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
  }[extension] ?? "application/octet-stream";
}
