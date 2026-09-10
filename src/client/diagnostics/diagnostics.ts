import pdfPackage from "pdfjs-dist/package.json";
import { buildId } from "../../shared/build";
import {
  diagnosticErrorCodes, type DiagnosticErrorCode, categoryForStatus, diagnosticCategories, diagnosticOperations, diagnosticStages, diagnosticSteps, diagnosticErrorTypes,
  isDiagnosticId, operationForUrl, safeBuildId,
  type DiagnosticCategory, type DiagnosticOperation, type DiagnosticStage, type DiagnosticStep, type DiagnosticErrorType,
} from "../../shared/diagnostics";

export const pdfEngineVersion = `pdfjs-${pdfPackage.version}`;
const pdfReasons = ["encrypted", "corrupt-pdf", "engine-unavailable", "version-mismatch", "timeout", "render-failed", "document-failed"] as const;
type PdfReason = typeof pdfReasons[number];
export function pdfFailureReason(error: unknown, rendering = false): PdfReason {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : "";
  if (name === "PasswordException") return "encrypted";
  if (name === "InvalidPDFException") return "corrupt-pdf";
  if (name === "PdfEngineUnavailableError") return "engine-unavailable";
  if (name === "ReaderDocumentVersionMismatchError") return "version-mismatch";
  if (name === "TimeoutError") return "timeout";
  return rendering ? "render-failed" : "document-failed";
}
export function diagnosticErrorType(error: unknown): DiagnosticErrorType {
  try {
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : null;
    if (name === "ZodError") return "ValidationError";
    return diagnosticErrorTypes.find(value => value === name) ?? "OtherError";
  } catch { return "OtherError"; }
}

export function diagnosticErrorCode(error: unknown): DiagnosticErrorCode | undefined {
  try {
    return error instanceof Error ? diagnosticErrorCodes.find(code => code === error.message) : undefined;
  } catch { return undefined; }
}

export function diagnosticCauseType(error: unknown): DiagnosticErrorType | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): DiagnosticErrorType | undefined => {
    if (!value || typeof value !== "object" || depth > 3 || seen.has(value)) return;
    seen.add(value);
    try {
      const nested = "cause" in value ? value.cause : "inner" in value ? value.inner : undefined;
      const failures = "failures" in value && Array.isArray(value.failures) ? value.failures.slice(0, 3) : [];
      for (const child of [nested, ...failures]) {
        if (!child) continue;
        const type = diagnosticErrorType(child);
        if (type !== "OtherError" && type !== "BulkError" && type !== "ModifyError") return type;
        const deeper = visit(child, depth + 1);
        if (deeper) return deeper;
      }
    } catch { /* Hostile or unsupported error shapes stay unclassified. */ }
  };
  return visit(error, 0);
}

interface Failure {
  step?: DiagnosticStep;
  errorType?: DiagnosticErrorType;
  causeType?: DiagnosticErrorType;
  errorCode?: DiagnosticErrorCode;
  engineVersion?: string;
  pdfReason?: PdfReason;
  operation: DiagnosticOperation;
  category: DiagnosticCategory;
  stage?: DiagnosticStage;
  requestId?: string | null;
  serverBuild?: string | null;
}
interface DiagnosticRecord {
  step?: DiagnosticStep;
  errorType?: DiagnosticErrorType;
  causeType?: DiagnosticErrorType;
  errorCode?: DiagnosticErrorCode;
  engineVersion?: string;
  pdfReason?: PdfReason;
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
const resetListeners = new Set<() => void>();
const responses = new WeakMap<Response, { operation: DiagnosticOperation; generation: number }>();
const retentionMs = 30 * 60_000;
let generation = 0;

export function clearDiagnostics() {
  generation += 1;
  records.length = 0;
  for (const listener of resetListeners) {
    try { listener(); } catch { /* Subscribers cannot block identity changes. */ }
  }
}

export function subscribeDiagnosticReset(listener: () => void) {
  resetListeners.add(listener);
  return () => { resetListeners.delete(listener); };
}

export function diagnosticScope() {
  const startedGeneration = generation;
  return (failure: Failure) => {
    if (generation === startedGeneration) recordFailure(failure);
  };
}

export class DiagnosticResponseError extends Error {
  constructor() { super("invalid_server_response"); }
}

export async function parseDiagnosticResponse<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch {
    const context = responses.get(response);
    if (context && context.generation === generation) {
      recordFailure({ operation: context.operation, stage: "decode", category: "internal",
        requestId: response.headers.get("X-Same-Page-Request-Id"),
        serverBuild: response.headers.get("X-Same-Page-Build"),
      });
    }
    throw new DiagnosticResponseError();
  }
}

export function pdfFailureCategory(error: unknown): DiagnosticCategory {
  if (error instanceof TypeError && /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/.test(error.message)) return "network";
  if (typeof error === "object" && error !== null) {
    if ("status" in error && typeof error.status === "number") {
      return error.status === 0 ? "network" : categoryForStatus(error.status);
    }
    if ("name" in error && ["InvalidPDFException", "PasswordException"].includes(String(error.name))) return "validation";
    // PDF.js wraps the browser's fetch TypeError across its worker channel.
    // Match only known transport details; an arbitrary UnknownErrorException
    // can also be a decoder fault and must stay internal. Never export details.
    if ("name" in error && error.name === "UnknownErrorException" && "details" in error &&
      ["TypeError: Failed to fetch", "TypeError: Load failed", "TypeError: NetworkError when attempting to fetch resource."].includes(String(error.details))) return "network";
  }
  return "internal";
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
    const step = diagnosticSteps.find(value => value === failure.step);
    const errorType = diagnosticErrorTypes.find(value => value === failure.errorType);
    const errorCode = diagnosticErrorCodes.find(value => value === failure.errorCode);
    const causeType = diagnosticErrorTypes.find(value => value === failure.causeType);
    const previous = [...records].reverse().find((entry) => entry.operation === operation && entry.category === category && entry.stage === stage && entry.step === step && entry.errorType === errorType && entry.causeType === causeType && entry.errorCode === errorCode && entry.pdfReason === failure.pdfReason && now - entry.time < 30_000);
    if (previous) {
      previous.count = Math.min(previous.count + 1, 9999);
      previous.time = now;
      previous.requestId = requestId;
      previous.serverBuild = serverBuild;
      return;
    }
    records.push({
      ...(step ? { step } : {}),
      ...(errorType ? { errorType } : {}),
      ...(causeType ? { causeType } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(failure.engineVersion && /^pdfjs-[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(failure.engineVersion) ? { engineVersion: failure.engineVersion } : {}),
      ...(failure.pdfReason && pdfReasons.includes(failure.pdfReason) ? { pdfReason: failure.pdfReason } : {}),
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
export const diagnosticFetch: typeof fetch = async (...args) => {
  const [input] = args;
  const startedGeneration = generation;
  const operation = operationForUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  try {
    const response = await globalThis.fetch(...args);
    responses.set(response, { operation, generation: startedGeneration });
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
