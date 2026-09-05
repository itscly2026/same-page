import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { verifyDeployment } from "./verify-deployment.mjs";

function deployment({ worker = "new-sha", build = "new-sha", shell = "new-sha", script = "new-sha", preload = false } = {}) {
  return async (url) => {
    const pathname = new URL(url).pathname;
    const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
    if (pathname === "/api/health") return json({ status: "ok", service: "same-page", runtime: "cloudflare-worker", buildId: worker });
    if (pathname === "/build.json") return json({ buildId: build });
    if (pathname === "/") return new Response(`<title>合谱 · Same Page</title><meta name="same-page-build-id" content="${shell}"><script src="/assets/app.js"></script>${preload ? '<link rel="modulepreload" href="/assets/shared.js">' : ""}`, { headers: { "content-type": "text/html", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    if (pathname === "/assets/app.js") return new Response(preload ? "entry without build identity" : script, { headers: { "cache-control": "public,max-age=31536000,immutable" } });
    if (pathname === "/assets/shared.js") return new Response(script, { headers: { "cache-control": "public,max-age=31536000,immutable" } });
    if (pathname === "/manifest.webmanifest") return Response.json({ name: "合谱 · Same Page", short_name: "合谱", display: "fullscreen" }, { headers: { "cache-control": "no-cache" } });
    if (pathname === "/sw.js") return new Response("/* service worker */".repeat(10), { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
    if (pathname === "/api/auth/social-providers") return json({ providers: [] });
    if (pathname === "/api/choirs") return json({ error: "unauthorized" }, 401);
    throw new Error(`unexpected request ${pathname}`);
  };
}
const manifest = (preload = false) => ({ buildId: "new-sha", scripts: Object.fromEntries(
  (preload ? [["/assets/app.js", "entry without build identity"], ["/assets/shared.js", "new-sha"]] : [["/assets/app.js", "new-sha"]])
    .map(([name, body]) => [name, createHash("sha256").update(body).digest("hex")])),
});
const verify = (fetchImpl, options = {}) => verifyDeployment({ baseUrl: "https://example.invalid", expectedBuildId: "new-sha", assetManifest: manifest(), fetchImpl, attempts: 1, ...options });
it("rejects a coherent old deployment instead of confirming a failed release", async () => {
  await expect(verify(deployment({ worker: "old-sha", build: "old-sha", shell: "old-sha", script: "old-sha" }))).rejects.toThrow(/expected build/);
});
it("accepts only the expected Worker, shell, identity and scripts", async () => {
  await expect(verify(deployment())).resolves.toBeUndefined();
  for (const component of ["worker", "build", "shell", "script"]) {
    await expect(verify(deployment({ [component]: "old-sha" }))).rejects.toThrow(/expected build/);
  }
});
it("waits for bounded propagation and reports the original mismatch on exhaustion", async () => {
  let reads = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === "/api/health") reads += 1;
    return deployment(reads < 2 ? { worker: "old-sha" } : {})(url);
  };
  await verify(fetchImpl, { attempts: 2, retryDelayMs: 0 });
  expect(reads).toBe(2);
  reads = 0;
  await expect(verify(fetchImpl, { attempts: 1 })).rejects.toMatchObject({ cause: { message: expect.stringContaining("same build") } });
});
it("requires an explicit expected version", async () => {
  await expect(verify(deployment(), { expectedBuildId: undefined })).rejects.toThrow(/required/);
});

it("verifies the loaded modulepreload graph when Vite moves identity out of the entry script", async () => {
  await expect(verify(deployment({ preload: true }), { assetManifest: manifest(true) })).resolves.toBeUndefined();
  await expect(verify(deployment({ preload: true, script: "old-sha" }), { assetManifest: manifest(true) })).rejects.toThrow(/expected build/);
});

it("rejects an old preload even when the entry contains the expected build ID", async () => {
  const live = deployment({ preload: true });
  await expect(verify(async (url) => {
    if (new URL(url).pathname === "/assets/app.js") return new Response("new-sha", { headers: { "cache-control": "max-age=31536000,immutable" } });
    if (new URL(url).pathname === "/assets/shared.js") return new Response("old-sha", { headers: { "cache-control": "max-age=31536000,immutable" } });
    return live(url);
  }, { assetManifest: { ...manifest(true), scripts: { ...manifest(true).scripts, "/assets/app.js": manifest().scripts["/assets/app.js"] } } })).rejects.toThrow(/expected build/);
});
