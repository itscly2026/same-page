import { parseDiagnosticResponse, diagnosticFetch, diagnosticScope } from "../diagnostics/diagnostics";
import { scoreCloudStateSchema } from "../../shared/scores";
import { localDatabase } from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  createLocalWorkspace,
  currentLocalOwnerKey,
  LocalWorkspaceOwnerChangedError,
  type LocalWorkspaceOwnerKey,
} from "../platform/local-workspace";
import { AnnotationPushError, pushPendingAnnotations } from "./sync";

export const OUTBOX_RECOVERY_REQUEST_EVENT =
  "same-page:annotation-outbox-recovery-request";

export const OUTBOX_RECOVERY_LIMITS = {
  discoveredOperations: 800,
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
  discoveredOperations: number;
  remainingOperations: number;
  discoveryLimitReached: boolean;
  results: readonly OutboxRecoveryScopeResult[];
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
    discoveredOperations: 0,
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
        discoveredOperations: 0,
        remainingOperations: 0,
        discoveryLimitReached: false,
        results: [],
      });
    }

    const ownerOutbox = localDatabase.annotationOutbox
      .where("ownerKey")
      .equals(ownerKey);
    const discovered = await ownerOutbox
      .limit(OUTBOX_RECOVERY_LIMITS.discoveredOperations)
      .toArray();
    discovered.sort((left, right) => left.createdAt - right.createdAt);
    const scopes = new Map<
      string,
      { scopeKey: string; choirId: string; scoreId: string }
    >();
    for (const operation of discovered) {
      if (scopes.has(operation.scopeKey)) continue;
      scopes.set(operation.scopeKey, {
        scopeKey: operation.scopeKey,
        choirId: operation.choirId,
        scoreId: operation.scoreId,
      });
      if (scopes.size === OUTBOX_RECOVERY_LIMITS.scopes) break;
    }

    const results: OutboxRecoveryScopeResult[] = [];
    for (const scope of scopes.values()) {
      results.push(await recoverScope(ownerKey, scope));
    }
    const remainingOperations = await ownerOutbox.count();
    return complete(run, {
      ownerKey,
      trigger,
      startedAt,
      scanOutcome: "completed",
      discoveredOperations: discovered.length,
      remainingOperations,
      discoveryLimitReached:
        discovered.length === OUTBOX_RECOVERY_LIMITS.discoveredOperations ||
        scopes.size === OUTBOX_RECOVERY_LIMITS.scopes,
      results,
    });
  } catch {
    reportFailure({ operation: "sync", category: "internal", stage: "prepare" });
    return complete(run, {
      ownerKey,
      trigger,
      startedAt,
      scanOutcome: "failed",
      discoveredOperations: 0,
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
  const workspace = createLocalWorkspace(ownerKey, scope.choirId, scope.scoreId);
  const result = (outcome: OutboxRecoveryScopeOutcome, pushed = 0) => ({
    ...scope,
    outcome,
    pushed,
  });
  if (workspace.scopeKey !== scope.scopeKey) return result("failed");

  try {
    await assertLocalWorkspaceActive(workspace);
    const response = await diagnosticFetch(
      `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/status`,
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
    discoveredOperations: 0,
    remainingOperations: 0,
    discoveryLimitReached: false,
    results: [],
  };
}
