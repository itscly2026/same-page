import assert from "node:assert/strict";

const baseUrl = new URL(process.argv[2] || "https://samepage.clyapps.com");
assert.equal(baseUrl.protocol, "https:", "deployment verification requires HTTPS");

const checks = [
  verifyHealth(),
  verifyAppShell(),
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

async function verifyHealth() {
  const response = await request("/api/health");
  assert.equal(response.status, 200, "health endpoint must return 200");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "same-page",
    runtime: "cloudflare-worker",
  });
}

async function verifyAppShell() {
  const response = await request("/");
  assert.equal(response.status, 200, "application shell must return 200");
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(await response.text(), /<title>Same Page<\/title>/);
}

async function verifyManifest() {
  const response = await request("/manifest.webmanifest");
  assert.equal(response.status, 200, "web app manifest must return 200");
  const manifest = await response.json();
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
  const response = await request("/api/auth/social-providers", {
    headers: { accept: "application/json" },
  });
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
