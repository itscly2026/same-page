import assert from "node:assert/strict";

const baseUrl = new URL(process.argv[2] || "https://samepage.clyapps.com");
assert.equal(baseUrl.protocol, "https:", "deployment verification requires HTTPS");

const [health, build] = await Promise.all([
  readHealth(),
  readBuild(),
]);
assert.equal(
  health.buildId,
  build.buildId,
  "Worker and application assets must come from the same build",
);

const checks = [
  verifyAppShell(build.buildId),
  verifyManifest(),
  verifyServiceWorker(),
  verifySocialProviderBoundary(),
  verifyUnauthenticatedBoundary(),
];

await Promise.all(checks);
process.stdout.write(`Verified deployment at ${baseUrl.origin}\n`);

async function request(path, init) {
  const response = await fetch(new URL(path, baseUrl), {
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
  assert.match(html, /<title>Same Page<\/title>/);
  const scriptPath = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(scriptPath, "application shell must load a hashed script");
  const script = await request(scriptPath);
  assert.equal(script.status, 200, "application script must return 200");
  assert.match(
    script.headers.get("cache-control") || "",
    /max-age=31536000.*immutable/,
    "hashed application assets must be immutable",
  );
  assert.match(
    await script.text(),
    new RegExp(escapeRegExp(expectedBuildId)),
    "application script must contain the active build identity",
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  assert.equal(manifest.name, "Same Page");
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
  const response = await requestUntilDeployed("/api/auth/social-providers");
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

async function requestUntilDeployed(path) {
  const attempts = 12;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request(path, {
      headers: { accept: "application/json" },
    });
    if (response.status !== 404 || attempt === attempts) return response;
    // Wrangler can finish before every Cloudflare edge sees the new Worker.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("deployment verification retry exhausted");
}
