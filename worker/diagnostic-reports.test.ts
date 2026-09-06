import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "./index";
import { cleanupDiagnosticReports } from "./diagnostic-reports";
import { diagnosticReportMaxBytes, diagnosticReportRetentionMs, type DiagnosticReport } from "../src/shared/diagnostic-report";

function report(): DiagnosticReport {
  return { id: crypto.randomUUID(), version: 1, clientBuild: "abcdef1", description: "没有报错，但页面显示不正常",
    environment: { browser: "safari", browserVersion: "18.1", system: "ios", systemVersion: "18.1", viewportWidth: 320, viewportHeight: 740,
      standalone: true, serviceWorkerControlled: true, onlineHint: true }, reader: null, records: [] };
}
function submit(body: unknown, headers: Record<string, string> = {}) {
  return worker.fetch(new Request("https://same-page.test/api/diagnostic-reports", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://same-page.test", "CF-Connecting-IP": "192.0.2.1", ...headers }, body: JSON.stringify(body),
  }), env, createExecutionContext());
}
beforeEach(async () => { await env.DB.batch([env.DB.prepare("DELETE FROM diagnostic_reports"), env.DB.prepare("DELETE FROM rate_limits")]); });
afterEach(() => vi.restoreAllMocks());

it("accepts an anonymous report without errors, durably stores it, and discloses only the receipt", async () => {
  const value = report();
  const response = await submit(value);
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ id: value.id });
  const row = await env.DB.prepare("SELECT * FROM diagnostic_reports WHERE id = ?").bind(value.id).first<{ payload: string; status: string; created_at: number; expires_at: number }>();
  expect(JSON.parse(row!.payload)).toEqual(value);
  expect(row!.status).toBe("new");
  expect(row!.expires_at - row!.created_at).toBe(diagnosticReportRetentionMs);
  expect(row!.payload).not.toContain("192.0.2.1");
  const limits = await env.DB.prepare("SELECT key FROM rate_limits").all();
  expect(JSON.stringify(limits.results)).not.toContain("192.0.2.1");
});

it("retries and concurrent retries create one immutable report without extending retention", async () => {
  const value = report();
  const responses = await Promise.all([submit(value), submit(value)]);
  expect(responses.every(response => response.ok)).toBe(true);
  const original = await env.DB.prepare("SELECT * FROM diagnostic_reports").first();
  expect((await submit(value)).status).toBe(200);
  expect((await submit({ ...value, description: "different" })).status).toBe(409);
  expect(await env.DB.prepare("SELECT * FROM diagnostic_reports").all().then(result => result.results)).toEqual([original]);
});

it("does not return a success receipt when storage fails and never logs user description", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    if (sql.startsWith("INSERT INTO diagnostic_reports")) throw new Error("private-db-detail");
    return prepare(sql);
  });
  const response = await submit({ ...report(), description: "private-description" });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private");
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
});

it("rejects sensitive extra fields at all levels and invalid bounded tokens", async () => {
  const value = report();
  for (const input of [
    { ...value, token: "never-store-this" },
    { ...value, environment: { ...value.environment, url: "private-url" } },
    { ...value, environment: { ...value.environment, browserVersion: "private-email@example.test" } },
    { ...value, reader: { displayMode: "pdf", interactionMode: "reading", pendingCount: 0, conflictCount: 0, scoreId: "private" } },
    { ...value, records: [{ id: crypto.randomUUID(), time: Date.now(), operation: "pdf", category: "internal", stage: "decode", serverBuild: null, requestId: null, retryable: true, count: 1, message: "private-stack" }] },
    { ...value, records: Array(51).fill({}) },
    { ...value, description: "x".repeat(1001) },
  ]) expect((await submit(input)).status).toBe(400);
  expect(await env.DB.prepare("SELECT count(*) AS count FROM diagnostic_reports").first()).toEqual({ count: 0 });
});

it("checks origin, media type and actual UTF-8 streamed byte limit", async () => {
  expect((await submit(report(), { Origin: "https://untrusted.test" })).status).toBe(403);
  expect((await submit(report(), { Origin: "" })).status).toBe(403);
  expect((await submit(report(), { "Content-Type": "text/plain" })).status).toBe(415);
  const bytes = new TextEncoder().encode(JSON.stringify({ description: "中".repeat(diagnosticReportMaxBytes / 2) }));
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.slice(0, 30000)); controller.enqueue(bytes.slice(30000)); controller.close();
  } });
  const response = await worker.fetch(new Request("https://same-page.test/api/diagnostic-reports", { method: "POST",
    headers: { Origin: "https://same-page.test", "Content-Type": "application/json" }, body: stream,
  }), env, createExecutionContext());
  expect(response.status).toBe(413);
});

it("rate limits submissions and offers Retry-After without storing raw IP", async () => {
  for (let index = 0; index < 20; index++) expect((await submit(report())).ok).toBe(true);
  const response = await submit(report());
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
});

it("global quota rejects new reports but still confirms an existing receipt", async () => {
  const value = report();
  expect((await submit(value)).ok).toBe(true);
  await env.DB.prepare("UPDATE rate_limits SET count = 2000 WHERE key = 'diagnostic-report:global'").run();
  expect((await submit(value)).ok).toBe(true);
  expect((await submit(report())).status).toBe(429);
});

it("offers no public report read or status update API even when the id is known", async () => {
  const value = report(); await submit(value);
  for (const [method, path] of [["GET", "/api/diagnostic-reports"], ["GET", `/api/diagnostic-reports/${value.id}`], ["PATCH", `/api/diagnostic-reports/${value.id}`]]) {
    expect((await worker.fetch(new Request(`https://same-page.test${path}`, { method }), env, createExecutionContext())).status).toBe(404);
  }
});

it("deletes expired reports at the exact retention boundary", async () => {
  const first = report(); const second = report(); await submit(first); await submit(second);
  const now = Date.now();
  await env.DB.prepare("UPDATE diagnostic_reports SET expires_at = ? WHERE id = ?").bind(now, first.id).run();
  await env.DB.prepare("UPDATE diagnostic_reports SET expires_at = ? WHERE id = ?").bind(now + 1, second.id).run();
  await cleanupDiagnosticReports(env.DB, now);
  expect((await env.DB.prepare("SELECT id FROM diagnostic_reports").all()).results).toEqual([{ id: second.id }]);
});

it("report cleanup failure leaves the other scheduled cleanup tasks running", async () => {
  await env.DB.prepare("INSERT INTO rate_limits VALUES ('expired', 1, 0)").run();
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation(sql => {
    if (sql.startsWith("DELETE FROM diagnostic_reports")) throw new Error("private-detail");
    return prepare(sql);
  });
  const context = createExecutionContext();
  worker.scheduled(createScheduledController(), env, context);
  await expect(waitOnExecutionContext(context)).rejects.toThrow("diagnostic_report_cleanup_failed");
  expect(await env.DB.prepare("SELECT count(*) AS count FROM rate_limits").first()).toEqual({ count: 0 });
});
