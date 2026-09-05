import Dexie from "dexie";
import { parseDiagnosticResponse, diagnosticFetch, diagnosticScope } from "../diagnostics/diagnostics";
import { scoreCloudStateSchema } from "../../shared/scores";
import { localDatabase } from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  captureLocalWorkspaceSession,
  createLocalWorkspace,
  currentLocalOwnerKey,
  LocalWorkspaceOwnerChangedError,
  type LocalWorkspaceOwnerKey,
} from "../platform/local-workspace";
import { AnnotationPushError, pushPendingAnnotations } from "./sync";

export const OUTBOX_RECOVERY_REQUEST_EVENT =
  "same-page:annotation-outbox-recovery-request";

export const OUTBOX_RECOVERY_LIMITS = {
  discoveredScopes: 800,
  scopes: 8,
  operationsPerScope: 100,
} as const;

export type OutboxRecoveryTrigger =
  | "startup"
  | "foreground"
  | "online"
  | "manual";

export type OutboxRecoveryScopeOutcome =
  | "pushed"
  | "busy"
  | "trashed"
  | "permission-revoked"
  | "session-invalid"
  | "unavailable"
  | "failed"
  | "owner-changed";

export interface OutboxRecoveryScopeResult {
  scopeKey: string;
  choirId: string;
  scoreId: string;
  outcome: OutboxRecoveryScopeOutcome;
  pushed: number;
}

export interface OutboxRecoverySummary {
  ownerKey: LocalWorkspaceOwnerKey | null;
  trigger: OutboxRecoveryTrigger | null;
  running: boolean;
  startedAt: number | null;
  completedAt: number | null;
  scanOutcome: "idle" | "running" | "completed" | "owner-changed" | "failed";
  discoveredScopes: number;
  remainingOperations: number;
  discoveryLimitReached: boolean;
  results: readonly OutboxRecoveryScopeResult[];
  nextAttemptAt?: number;
}

let recoverySummary: OutboxRecoverySummary = emptySummary();
let latestRun = 0;

export function getOutboxRecoverySummary(): OutboxRecoverySummary {
  return recoverySummary;
}

export function requestOutboxRecovery() {
  window.dispatchEvent(new Event(OUTBOX_RECOVERY_REQUEST_EVENT));
}

export async function recoverAnnotationOutbox(
  ownerKey: LocalWorkspaceOwnerKey,
  trigger: OutboxRecoveryTrigger,
): Promise<OutboxRecoverySummary> {
  const run = ++latestRun;
  const reportFailure = diagnosticScope();
  const startedAt = Date.now();
  publish(run, {
    ownerKey,
    trigger,
    running: true,
    startedAt,
    completedAt: null,
    scanOutcome: "running",
    discoveredScopes: 0,
    remainingOperations: 0,
    discoveryLimitReached: false,
    results: [],
  });

  try {
    if ((await currentLocalOwnerKey()) !== ownerKey) {
      return complete(run, {
        ownerKey,
        trigger,
        startedAt,
        scanOutcome: "owner-changed",
        discoveredScopes: 0,
        remainingOperations: 0,
        discoveryLimitReached: false,
        results: [],
      });
    }

    const ownerOutbox = localDatabase.annotationOutbox
      .where("ownerKey")
      .equals(ownerKey);
    const cursorKey = `annotation-recovery-cursor:${ownerKey}`;
    const cursor = (await localDatabase.system.get(cursorKey))?.value ?? "";
    const scopeKeys = await localDatabase.annotationOutbox
      .where("[ownerKey+scopeKey]").between([ownerKey, cursor], [ownerKey, Dexie.maxKey], false, true)
      .limit(OUTBOX_RECOVERY_LIMITS.discoveredScopes).uniqueKeys();
    const wrapped = await localDatabase.annotationOutbox
      .where("[ownerKey+scopeKey]").between([ownerKey, Dexie.minKey], [ownerKey, cursor], true, true)
      .limit(OUTBOX_RECOVERY_LIMITS.discoveredScopes).uniqueKeys();
    const discovered = [...scopeKeys, ...wrapped].slice(0, OUTBOX_RECOVERY_LIMITS.discoveredScopes);
    const results: OutboxRecoveryScopeResult[] = [];
    let nextAttemptAt = Date.now() + 1_000;
    let earliestRetry = Number.POSITIVE_INFINITY;
    for (const compoundKey of discovered) {
      if (!Array.isArray(compoundKey)) continue;
      const scopeKey = String(compoundKey[1]);
      await localDatabase.system.put({ key: cursorKey, value: scopeKey });
      const retryKey = `annotation-recovery-retry:${scopeKey}`;
      const retry = JSON.parse((await localDatabase.system.get(retryKey))?.value ?? '{"failures":0,"at":0}') as { failures: number; at: number };
      if (retry.at > Date.now()) { earliestRetry = Math.min(earliestRetry, retry.at); continue; }
      const claimed = await localDatabase.transaction("rw", localDatabase.system, async () => {
        if ((await currentLocalOwnerKey()) !== ownerKey) return false;
        const current = JSON.parse((await localDatabase.system.get(retryKey))?.value ?? '{"at":0}') as { at: number };
        if (current.at > Date.now()) return false;
        await localDatabase.system.put({ key: retryKey, value: JSON.stringify({ failures: retry.failures, at: Date.now() + 120_000 }) });
        return true;
      });
      if (!claimed) continue;
      const operation = await localDatabase.annotationOutbox.where("scopeKey").equals(scopeKey).first();
      if (!operation) continue;
      const { choirId, scoreId } = operation;
      const result = await recoverScope(ownerKey, { scopeKey, choirId, scoreId });
      results.push(result);
      const failures = result.outcome === "pushed" && result.pushed > 0 ? 0 : retry.failures + 1;
      const at = Date.now() + (failures ? Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6)) : 1_000);
      earliestRetry = Math.min(earliestRetry, at);
      await localDatabase.system.put({ key: retryKey, value: JSON.stringify({ failures, at }) });
      if (result.outcome === "owner-changed") break;
      if (results.length === OUTBOX_RECOVERY_LIMITS.scopes) break;
    }
    if (results.length < OUTBOX_RECOVERY_LIMITS.scopes && discovered.length < OUTBOX_RECOVERY_LIMITS.discoveredScopes) nextAttemptAt = earliestRetry;
    const remainingOperations = await ownerOutbox.count();
    return complete(run, {
      ownerKey,
      trigger,
      startedAt,
      scanOutcome: "completed",
      discoveredScopes: discovered.length,
      remainingOperations,
      discoveryLimitReached:
        discovered.length === OUTBOX_RECOVERY_LIMITS.discoveredScopes ||
        results.length === OUTBOX_RECOVERY_LIMITS.scopes,
      nextAttemptAt: Number.isFinite(nextAttemptAt) ? nextAttemptAt : undefined,
      results,
    });
  } catch {
    reportFailure({ operation: "sync", category: "internal", stage: "prepare" });
    return complete(run, {
      ownerKey,
      trigger,
      startedAt,
      scanOutcome: "failed",
      discoveredScopes: 0,
      remainingOperations: 0,
      discoveryLimitReached: false,
      results: [],
    });
  }
}

async function recoverScope(
  ownerKey: LocalWorkspaceOwnerKey,
  scope: { scopeKey: string; choirId: string; scoreId: string },
): Promise<OutboxRecoveryScopeResult> {
  let workspace = createLocalWorkspace(ownerKey, scope.choirId, scope.scoreId);
  const result = (outcome: OutboxRecoveryScopeOutcome, pushed = 0) => ({
    ...scope,
    outcome,
    pushed,
  });
  if (workspace.scopeKey !== scope.scopeKey) return result("failed");

  try {
    workspace = await captureLocalWorkspaceSession(workspace);
    const response = await diagnosticFetch(
      `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/status`,
      { signal: AbortSignal.timeout(30_000) },
    );
    await assertLocalWorkspaceActive(workspace);
    if (response.status === 401) return result("session-invalid");
    if (response.status === 403) return result("permission-revoked");
    if (!response.ok) return result("unavailable");
    const cloudState = await parseDiagnosticResponse(response, scoreCloudStateSchema);
    if (cloudState.state === "trashed") return result("trashed");
    await assertLocalWorkspaceActive(workspace);
    const pushed = await pushPendingAnnotations(workspace, {
      maxOperations: OUTBOX_RECOVERY_LIMITS.operationsPerScope,
    });
    return pushed === undefined ? result("busy") : result("pushed", pushed);
  } catch (error) {
    if (error instanceof LocalWorkspaceOwnerChangedError) {
      return result("owner-changed");
    }
    if (error instanceof AnnotationPushError) {
      if (error.responseStatus === 401) return result("session-invalid");
      if (error.responseStatus === 403) return result("permission-revoked");
    }
    return result("failed");
  }
}

function complete(
  run: number,
  summary: Omit<OutboxRecoverySummary, "running" | "completedAt">,
) {
  const completed: OutboxRecoverySummary = {
    ...summary,
    running: false,
    completedAt: Date.now(),
  };
  publish(run, completed);
  return completed;
}

function publish(run: number, summary: OutboxRecoverySummary) {
  if (run === latestRun) recoverySummary = summary;
}

function emptySummary(): OutboxRecoverySummary {
  return {
    ownerKey: null,
    trigger: null,
    running: false,
    startedAt: null,
    completedAt: null,
    scanOutcome: "idle",
    discoveredScopes: 0,
    remainingOperations: 0,
    discoveryLimitReached: false,
    results: [],
  };
}
