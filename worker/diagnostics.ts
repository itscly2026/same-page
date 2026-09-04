import type { MiddlewareHandler } from "hono";
import { buildId } from "../src/shared/build";
import { categoryForStatus, diagnosticOperations, diagnosticStages, isDiagnosticId, operationForUrl, safeBuildId, type DiagnosticOperation, type DiagnosticStage } from "../src/shared/diagnostics";
import type { AppEnvironment } from "./env";

// Per isolate, per fixed operation/status bucket: first failure in a minute,
// then a bounded count on the next emitted failure. No user-derived keys.
const buckets = new Map<string, { time: number; suppressed: number }>();

export function logFailure(operation: DiagnosticOperation, stage: DiagnosticStage, status: number, requestId: string) {
  try {
    if (!diagnosticOperations.includes(operation) || !diagnosticStages.includes(stage) || !isDiagnosticId(requestId)) return;
    const now = Date.now();
    const category = categoryForStatus(status);
    const key = `${operation}:${stage}:${category}`;
    const previous = buckets.get(key);
    if (previous && now - previous.time < 60_000) {
      previous.suppressed = Math.min(9999, previous.suppressed + 1);
      return;
    }
    buckets.set(key, { time: now, suppressed: 0 });
    console.info(JSON.stringify({ event: "same_page_failure", requestId, buildId: safeBuildId(buildId),
      operation, stage, category, retryable: status >= 500 || status === 429,
      suppressed: previous?.suppressed ?? 0,
    }));
  } catch { /* A logging failure must not replace the actual response. */ }
}

export const diagnosticMiddleware: MiddlewareHandler<AppEnvironment> = async (context, next) => {
  // Do not trust caller-provided correlation headers.
  const requestId = crypto.randomUUID();
  context.header("X-Same-Page-Request-Id", requestId);
  context.header("X-Same-Page-Build", buildId);
  await next();
  if (context.res.status >= 400) logFailure(operationForUrl(context.req.url), "request", context.res.status, requestId);
};
