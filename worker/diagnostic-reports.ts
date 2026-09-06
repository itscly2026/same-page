import { Hono } from "hono";
import { diagnosticReportMaxBytes, diagnosticReportRetentionMs, diagnosticReportSchema } from "../src/shared/diagnostic-report";
import type { AppEnvironment } from "./env";
import { consumeRateLimit, hashRateLimitIdentity } from "./security/rate-limit";

export const diagnosticReportRoutes = new Hono<AppEnvironment>();
diagnosticReportRoutes.post("/diagnostic-reports", async (context) => {
  context.header("Cache-Control", "no-store");
  // This endpoint is intentionally available during authentication failures.
  if (context.req.header("Origin") !== new URL(context.env.BETTER_AUTH_URL).origin) {
    return context.json({ error: "forbidden" }, 403);
  }
  if (context.req.header("Content-Type")?.split(";")[0].trim() !== "application/json") {
    return context.json({ error: "invalid_report" }, 415);
  }
  const identity = await hashRateLimitIdentity(`diagnostic-report:${context.req.header("CF-Connecting-IP") ?? "unknown"}`, context.env.INVITE_SECRET);
  const limit = await consumeRateLimit(context.env.DB, `diagnostic-report:${identity}`, { maxAttempts: 20, windowMs: 15 * 60_000 });
  if (!limit.allowed) {
    context.header("Retry-After", String(limit.retryAfterSeconds));
    return context.json({ error: "rate_limited" }, 429);
  }
  // Count actual streamed bytes, even with no or misleading Content-Length.
  const reader = context.req.raw.body?.getReader();
  if (!reader) return context.json({ error: "invalid_report" }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > diagnosticReportMaxBytes) {
        await reader.cancel();
        return context.json({ error: "report_too_large" }, 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return context.json({ error: "invalid_report" }, 400);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { return context.json({ error: "invalid_report" }, 400); }
  const parsed = diagnosticReportSchema.safeParse(input);
  if (!parsed.success) return context.json({ error: "invalid_report" }, 400);
  const report = parsed.data;
  const payload = JSON.stringify(report);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const existing = await context.env.DB.prepare("SELECT payload_hash FROM diagnostic_reports WHERE id = ?").bind(report.id).first<{ payload_hash: string }>();
  if (existing) return existing.payload_hash === hash
    ? context.json({ id: report.id })
    : context.json({ error: "report_changed" }, 409);
  // Bound anonymous submissions across addresses as well as per address.
  const globalLimit = await consumeRateLimit(context.env.DB, "diagnostic-report:global", { maxAttempts: 2000, windowMs: 24 * 60 * 60_000 });
  if (!globalLimit.allowed) {
    context.header("Retry-After", String(globalLimit.retryAfterSeconds));
    return context.json({ error: "rate_limited" }, 429);
  }
  await context.env.DB.prepare(`INSERT INTO diagnostic_reports
    (id, client_build, payload, payload_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(report.id, report.clientBuild, payload, hash, now, now + diagnosticReportRetentionMs).run();
  // Concurrent duplicate submissions must not overwrite content or return a false receipt.
  const saved = await context.env.DB.prepare("SELECT payload_hash FROM diagnostic_reports WHERE id = ?").bind(report.id).first<{ payload_hash: string }>();
  if (!saved) throw new Error("diagnostic_report_not_saved");
  if (saved.payload_hash !== hash) return context.json({ error: "report_changed" }, 409);
  return context.json({ id: report.id }, 201);
});

export async function cleanupDiagnosticReports(db: D1Database, now = Date.now()) {
  // The ingress cap bounds the daily volume; delete every expired report each hour.
  await db.prepare("DELETE FROM diagnostic_reports WHERE expires_at <= ?").bind(now).run();
}
