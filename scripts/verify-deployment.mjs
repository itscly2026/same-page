import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  isReleaseScriptPath,
  shellJavaScriptAssets,
} from "./deployment-identity.mjs";

export async function verifyDeployment({
  baseUrl: origin,
  expectedBuildId,
  assetManifest,
  fetchImpl = fetch,
  attempts = 12,
  retryDelayMs = 3_000,
}) {
  const baseUrl = new URL(origin);
  assert.equal(baseUrl.protocol, "https:", "deployment verification requires HTTPS");
  assert.ok(typeof expectedBuildId === "string" && expectedBuildId.trim(), "expected buildId is required");
  assert.equal(assetManifest?.buildId, expectedBuildId, "verified asset manifest must match expected buildId");
  const scriptHashes = Object.entries(assetManifest.scripts ?? {});
  assert.ok(scriptHashes.length > 0, "verified script manifest is empty");
  for (const [scriptPath, hash] of scriptHashes) {
    assert.ok(isReleaseScriptPath(scriptPath), `unrecognized release script path: ${scriptPath}`);
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
  assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 12);
  await readCoherentDeployment();

  async function request(path, init) {
    const response = await fetchImpl(new URL(path, baseUrl), {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
    return response;
  }

  async function readHealth() {
    const response = await request("/api/health");
    assert.equal(response.status, 200, "health endpoint must return 200");
    const payload = await response.json();
    assert.equal(payload.status, "ok");
    assert.equal(payload.service, "same-page");
    assert.equal(payload.runtime, "cloudflare-worker");
    assert.equal(typeof payload.buildId, "string");
    assert.ok(payload.buildId.length > 0, "health build id must not be empty");
    return payload;
  }

  async function readBuild() {
    const response = await request("/build.json");
    assert.equal(response.status, 200, "build identity must return 200");
    assert.match(
      response.headers.get("content-type") || "",
      /application\/json/,
      "build identity must be JSON rather than an old application shell",
    );
    const payload = await response.json();
    assert.equal(typeof payload.buildId, "string");
    assert.ok(payload.buildId.length > 0, "asset build id must not be empty");
    return payload;
  }

  async function verifyAppShell(expectedBuildId) {
    const response = await request("/");
    assert.equal(response.status, 200, "application shell must return 200");
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const html = await response.text();
    assert.match(html, /<title>合谱 · Same Page<\/title>/);
    assert.ok(html.includes(`<meta name="same-page-build-id" content="${expectedBuildId}">`), "application shell must contain the expected build identity");
    const scriptPaths = shellJavaScriptAssets(html);
    assert.ok(scriptPaths.length > 0, "application shell must load hashed scripts");
    for (const scriptPath of scriptPaths) {
      assert.ok(Object.hasOwn(assetManifest.scripts, scriptPath), "shell references a script outside the verified release");
    }
    await Promise.all(scriptHashes.map(async ([scriptPath, hash]) => {
      const script = await request(scriptPath);
      assert.equal(script.status, 200, "application script must return 200");
      assert.match(script.headers.get("cache-control") || "", /max-age=31536000.*immutable/, "hashed application assets must be immutable");
      const actual = createHash("sha256").update(new Uint8Array(await script.arrayBuffer())).digest("hex");
      assert.equal(actual, hash, `application script differs from verified release: ${scriptPath}`);
    }));
  }

  async function readCoherentDeployment() {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const [health, build] = await Promise.all([readHealth(), readBuild()]);
        assert.equal(
          health.buildId,
          build.buildId,
          "Worker and application assets must come from the same build",
        );
        assert.equal(build.buildId, expectedBuildId, "deployment must match the expected build identity");
        await verifyAppShell(expectedBuildId);
        await Promise.all([verifyManifest(), verifyServiceWorker(), verifySocialProviderBoundary(), verifyUnauthenticatedBoundary()]);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    throw new Error("production did not reach the expected build", { cause: lastError });
  }

  async function verifyManifest() {
    const response = await request("/manifest.webmanifest");
    assert.equal(response.status, 200, "web app manifest must return 200");
    const manifest = await response.json();
    assert.match(
      response.headers.get("cache-control") || "",
      /no-cache|max-age=0/,
      "manifest must be revalidated",
    );
    assert.equal(manifest.name, "合谱 · Same Page");
    assert.equal(manifest.short_name, "合谱");
    assert.equal(manifest.display, "fullscreen");
  }

  async function verifyServiceWorker() {
    const response = await request("/sw.js");
    assert.equal(response.status, 200, "service worker must return 200");
    assert.match(
      response.headers.get("content-type") || "",
      /javascript|text\/plain/,
    );
    assert.match(
      response.headers.get("cache-control") || "",
      /no-cache|max-age=0/,
      "service worker must be revalidated",
    );
    assert.ok((await response.text()).length > 100, "service worker is empty");
  }

  async function verifyUnauthenticatedBoundary() {
    const response = await request("/api/choirs", {
      headers: { accept: "application/json" },
    });
    assert.equal(response.status, 401, "choir listing must require authentication");
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }

  async function verifySocialProviderBoundary() {
    const response = await request("/api/auth/social-providers");
    assert.equal(response.status, 200, "social provider endpoint must return 200");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.ok(Array.isArray(payload.providers));
    assert.equal(new Set(payload.providers).size, payload.providers.length);
    assert.ok(
      payload.providers.every((provider) =>
        ["google", "wechat"].includes(provider),
      ),
      "only supported social providers may be exposed",
    );
  }

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , baseUrl, expectedBuildId, manifestPath = "dist/client/build.json"] = process.argv;
  const assetManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await verifyDeployment({ baseUrl, expectedBuildId, assetManifest });
  process.stdout.write(`Verified deployment ${expectedBuildId} at ${new URL(baseUrl).origin}\n`);
}
