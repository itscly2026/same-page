import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "vite";

// Actual application modules + persistent IndexedDB; no fake-indexeddb and no
// production requests. A private module harness avoids requiring a Worker for
// this browser storage regression, and is not part of the product build.
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  test(`${name}: outbox discovery skips duplicates, isolates owners and rotates scopes`, { timeout: 60_000 }, async t => {
    const server = await createServer({ configFile: false, server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { noDiscovery: true, include: ["dexie", "zod"] },
      plugins: [{ name: "storage-test-page", configureServer(server) {
        server.middlewares.use("/storage-test", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>Storage test</title>"); });
      } }],
    });
    t.after(() => server.close());
    await server.listen();
    const profile = await mkdtemp(path.join(tmpdir(), "same-page-outbox-"));
    t.after(() => rm(profile, { recursive: true, force: true }));
    const context = await engine.launchPersistentContext(profile, { headless: true });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.goto(server.resolvedUrls.local[0] + "storage-test");
    const result = await page.evaluate(async () => {
      const { localDatabase: db } = await import("/src/client/platform/local-database.ts");
      const { activateAuthenticatedLocalOwner, createLocalWorkspace } = await import("/src/client/platform/local-workspace.ts");
      const { recoverAnnotationOutbox, OUTBOX_RECOVERY_LIMITS: limits } = await import("/src/client/annotations/outbox-recovery.ts");
      const { exportDiagnostics } = await import("/src/client/diagnostics/diagnostics.ts");
      const owner = await activateAuthenticatedLocalOwner("test-owner");
      const empty = await recoverAnnotationOutbox(owner, "startup");
      const ops = [];
      const seed = (user, score, count) => {
        const workspace = createLocalWorkspace(user, "test-drive", score);
        for (let i = 0; i < count; i++) ops.push({ ...workspace, opId: `${user}:${score}:${i}`,
          annotationId: `note-${i}`, layerId: "layer", baseVersion: 0, type: "delete", payload: null, attemptedAt: null, createdAt: i });
      };
      seed(owner, "score-00", limits.discoveredScopes + 10);
      for (let i = 1; i < 12; i++) seed(owner, `score-${String(i).padStart(2, "0")}`, 1);
      seed("user:someone-else", "foreign", 1);
      await db.annotationOutbox.bulkPut(ops);
      // No pushes: failed status requests must preserve every operation while
      // still rotating fairly. The browser's actual storage remains unmocked.
      globalThis.fetch = async () => new Response(null, { status: 503 });
      const first = await recoverAnnotationOutbox(owner, "manual");
      const second = await recoverAnnotationOutbox(owner, "manual");
      const remaining = await db.annotationOutbox.count();
      return { empty, first, second, remaining, seeded: ops.length, diagnostics: JSON.parse(exportDiagnostics()).records };
    });
    assert.equal(result.empty.scanOutcome, "completed");
    assert.equal(result.first.scanOutcome, "completed");
    assert.equal(result.first.discoveredScopes, 12);
    assert.equal(result.first.results.length, 8);
    assert.equal(result.second.scanOutcome, "completed");
    assert.equal(result.second.results.length, 4);
    assert.equal(new Set([...result.first.results, ...result.second.results].map(r => r.scoreId)).size, 12);
    assert.equal(result.remaining, result.seeded);
    assert.ok(!result.diagnostics.some(r => r.stage === "prepare"));
  });
}
