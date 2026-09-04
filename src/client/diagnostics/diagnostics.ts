import { buildId } from "../../shared/build";
import {
  categoryForStatus, diagnosticCategories, diagnosticOperations, diagnosticStages,
  isDiagnosticId, operationForUrl, safeBuildId,
  type DiagnosticCategory, type DiagnosticOperation, type DiagnosticStage,
} from "../../shared/diagnostics";

interface Failure {
  operation: DiagnosticOperation;
  category: DiagnosticCategory;
  stage?: DiagnosticStage;
  requestId?: string | null;
  serverBuild?: string | null;
}
interface DiagnosticRecord {
  id: string;
  time: number;
  operation: DiagnosticOperation;
  category: DiagnosticCategory;
  stage: DiagnosticStage;
  serverBuild: string | null;
  requestId: string | null;
  retryable: boolean;
  count: number;
}

const records: DiagnosticRecord[] = [];
const retentionMs = 30 * 60_000;
let generation = 0;

export function clearDiagnostics() {
  generation += 1;
  records.length = 0;
}

export function recordFailure(failure: Failure) {
  // Diagnostics must never be able to fail the business operation. Build a new
  // object from runtime-validated fields, never spread input or serialize errors.
  try {
    const now = Date.now();
    prune(now);
    const operation = diagnosticOperations.includes(failure.operation) ? failure.operation : "other";
    const category = diagnosticCategories.includes(failure.category) ? failure.category : "internal";
    const stage = failure.stage && diagnosticStages.includes(failure.stage) ? failure.stage : "request";
    const requestId = isDiagnosticId(failure.requestId) ? failure.requestId : null;
    const serverBuild = safeBuildId(failure.serverBuild);
    const previous = [...records].reverse().find((entry) => entry.operation === operation && entry.category === category && entry.stage === stage && now - entry.time < 30_000);
    if (previous) {
      previous.count = Math.min(previous.count + 1, 9999);
      previous.time = now;
      previous.requestId = requestId;
      previous.serverBuild = serverBuild;
      return;
    }
    records.push({
      id: crypto.randomUUID(), time: now, operation, category, stage,
      requestId, serverBuild, count: 1,
      retryable: category === "network" || category === "internal" || category === "rate-limit",
    });
    if (records.length > 50) records.shift();
  } catch { /* Best effort only. */ }
}

export function exportDiagnostics() {
  prune(Date.now());
  return JSON.stringify({ version: 1, clientBuild: safeBuildId(buildId), records }, null, 2);
}

function prune(now: number) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (now - records[index].time >= retentionMs) records.splice(index, 1);
  }
}

// Same fetch contract: no retries, response consumption, request mutation, or
// global monkey patch. Callers retain their existing recovery/authorization flow.
export const diagnosticFetch: typeof fetch = async (input, init) => {
  const startedGeneration = generation;
  const operation = operationForUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  try {
    const response = await globalThis.fetch(input, init);
    if (!response.ok && startedGeneration === generation) {
      recordFailure({ operation, category: categoryForStatus(response.status),
        requestId: response.headers.get("X-Same-Page-Request-Id"),
        serverBuild: response.headers.get("X-Same-Page-Build"),
      });
    }
    return response;
  } catch (error) {
    if (startedGeneration === generation && !(error instanceof DOMException && error.name === "AbortError")) {
      recordFailure({ operation, category: "network" });
    }
    throw error;
  }
};
