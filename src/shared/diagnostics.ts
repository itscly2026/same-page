export const diagnosticOperations = ["auth", "drive", "layers", "pdf", "sync", "storage", "other"] as const;
export type DiagnosticOperation = typeof diagnosticOperations[number];
export const diagnosticCategories = ["permission", "validation", "conflict", "not-found", "rate-limit", "network", "internal"] as const;
export type DiagnosticCategory = typeof diagnosticCategories[number];
export const diagnosticStages = ["request", "prepare", "decode", "push", "cleanup"] as const;
export type DiagnosticStage = typeof diagnosticStages[number];

export const diagnosticSteps = ["outbox-scan", "sync-lock", "sync-layers", "sync-layers-request", "sync-layers-response", "sync-layers-identity", "sync-layers-cache", "sync-layers-snapshot", "reader-source", "reader-document", "reader-presentation", "sync-push", "sync-pull", "sync-apply", "draft-save", "sync-retry", "conflict-resolve", "offline-read", "offline-file", "offline-manifest", "offline-snapshot"] as const;
export type DiagnosticStep = typeof diagnosticSteps[number];
export const diagnosticErrorTypes = ["BulkError", "ModifyError", "TimeoutError", "UnknownError", "NotReadableError", "DatabaseClosedError", "TransactionInactiveError", "QuotaExceededError", "DataError", "SchemaError", "InvalidStateError", "AbortError", "SecurityError", "NotFoundError", "ConstraintError", "TypeError", "ValidationError", "OtherError"] as const;
export type DiagnosticErrorType = typeof diagnosticErrorTypes[number];

export function categoryForStatus(status: number): DiagnosticCategory {
  if (status === 401 || status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limit";
  return status >= 500 ? "internal" : "validation";
}

// Only fixed categories escape this function. Never retain or return the URL.
export function operationForUrl(url: string): DiagnosticOperation {
  try {
    const path = new URL(url, "https://same-page.invalid").pathname;
    if (/^\/api\/auth(?:\/|$)/.test(path)) return "auth";
    if (/\/annotations(?:\/|$)/.test(path)) return "sync";
    if (/\/(?:layers|shared-layers)(?:\/|$)/.test(path)) return "layers";
    if (/\/pdf$/.test(path)) return "pdf";
    if (/^\/api\/(?:choirs|guest)(?:\/|$)/.test(path)) return "drive";
  } catch { /* Malformed URLs remain unclassified. */ }
  return "other";
}

export function isDiagnosticId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function safeBuildId(value: unknown): string | null {
  return typeof value === "string" && /^(?:[0-9a-f]{7,40}|development)$/.test(value) ? value : null;
}

export const diagnosticErrorCodes = ["annotation_layer_access_denied", "annotation_layers_unavailable", "invalid_server_response", "annotation_layer_identity_mismatch", "shared_layer_state_changed", "offline_file_read_timeout"] as const;
export type DiagnosticErrorCode = typeof diagnosticErrorCodes[number];
