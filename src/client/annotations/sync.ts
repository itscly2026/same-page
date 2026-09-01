import {
  annotationPullResponseSchema,
  type AnnotationObjectRecord,
} from "../../shared/annotations";
import {
  annotationRecordKey,
  localDatabase,
  type AnnotationOutboxRecord,
} from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  LocalWorkspaceOwnerChangedError,
  type LocalWorkspace,
  withLocalWorkspaceTransaction,
} from "../platform/local-workspace";
import { applyPulledAnnotations, applyPushResults } from "./local-annotations";

export async function syncAnnotations(
  workspace: LocalWorkspace,
  options: { pull: boolean },
) {
  await assertLocalWorkspaceActive(workspace);
  return withScoreSyncLock(workspace, async () => {
    const pushed = await drainAnnotationOutbox(workspace);
    let pulled = 0;
    if (options.pull) {
      await assertLocalWorkspaceActive(workspace);
      const cursor = (
        await localDatabase.annotationSyncCursors.get(workspace.scopeKey)
      )?.cursor ?? 0;
      const response = await fetch(
        `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/annotations?cursor=${cursor}`,
      );
      if (!response.ok) throw new Error("annotation_pull_failed");
      const body = annotationPullResponseSchema.parse(await response.json());
      await assertLocalWorkspaceActive(workspace);
      await applyPulledAnnotations(workspace, body.cursor, body.objects);
      pulled = body.objects.length;
    }
    return { pushed, pulled };
  });
}

export class AnnotationPushError extends Error {
  constructor(readonly responseStatus: number) {
    super("annotation_push_failed");
  }
}

export async function pushPendingAnnotations(
  workspace: LocalWorkspace,
  options: { maxOperations: number },
) {
  await assertLocalWorkspaceActive(workspace);
  return withScoreSyncLock(workspace, () =>
    drainAnnotationOutbox(workspace, options),
  );
}

async function drainAnnotationOutbox(
  workspace: LocalWorkspace,
  options: { maxOperations?: number } = {},
) {
  await assertLocalWorkspaceActive(workspace);
  let pushed = 0;
  const maxOperations = options.maxOperations ?? Number.POSITIVE_INFINITY;
  while (pushed < maxOperations) {
    const batch = await withLocalWorkspaceTransaction(
      workspace,
      "rw",
      [
        localDatabase.annotations,
        localDatabase.annotationOutbox,
        localDatabase.annotationConflicts,
      ],
      async () => {
        const operations = await localDatabase.annotationOutbox
          .where("scopeKey")
          .equals(workspace.scopeKey)
          .sortBy("createdAt");
        const discardedOperationIds = new Set<string>();
        for (const invalidDelete of operations.filter(
          (operation) =>
            operation.baseVersion === 0 && operation.type === "delete",
        )) {
          const related = operations.filter(
            (operation) =>
              operation.annotationId === invalidDelete.annotationId,
          );
          const attemptedCreate = related.find(
            (operation) =>
              operation.baseVersion === 0 &&
              operation.type === "upsert" &&
              operation.attemptedAt !== null,
          );
          discardedOperationIds.add(invalidDelete.opId);
          if (attemptedCreate) {
            for (const operation of related) {
              if (operation.attemptedAt === null) {
                discardedOperationIds.add(operation.opId);
              }
            }
            const local = await localDatabase.annotations.get(
              annotationRecordKey(workspace.scopeKey, invalidDelete.annotationId),
            );
            if (local?.version === 0) {
              await localDatabase.annotations.update(local.key, {
                deleted: true,
                payload: null,
                state: "pending",
                lastOpId: attemptedCreate.opId,
              });
            }
            continue;
          }
          for (const operation of related) {
            if (operation.attemptedAt === null) {
              discardedOperationIds.add(operation.opId);
            }
          }
          const key = annotationRecordKey(
            workspace.scopeKey,
            invalidDelete.annotationId,
          );
          const local = await localDatabase.annotations.get(key);
          if (local?.version === 0 && local.deleted) {
            await localDatabase.annotations.delete(key);
          }
          const pseudoConflicts = await localDatabase.annotationConflicts
            .where("[scopeKey+annotationId]")
            .equals([workspace.scopeKey, invalidDelete.annotationId])
            .filter(
              (conflict) =>
                conflict.opId === invalidDelete.opId &&
                conflict.localDeleted &&
                conflict.canonical === null,
            )
            .toArray();
          await localDatabase.annotationConflicts.bulkDelete(
            pseudoConflicts.map((conflict) => conflict.opId),
          );
        }
        await localDatabase.annotationOutbox.bulkDelete([
          ...discardedOperationIds,
        ]);
        const seenAnnotationIds = new Set<string>();
        const selected = operations
          .filter(
            (operation) => !discardedOperationIds.has(operation.opId),
          )
          .filter((operation) => {
            if (seenAnnotationIds.has(operation.annotationId)) return false;
            seenAnnotationIds.add(operation.annotationId);
            return true;
          })
          .slice(0, Math.min(100, maxOperations - pushed));
        for (const operation of selected) {
          assertOutboxOperation(operation);
        }
        await localDatabase.annotationOutbox.bulkUpdate(
          selected.map((operation) => ({
            key: operation.opId,
            changes: { attemptedAt: Date.now() },
          })),
        );
        return selected;
      },
    );
    if (batch.length === 0) return pushed;
    await assertLocalWorkspaceActive(workspace);
    const expectedUserId = authenticatedUserId(workspace);
    if (!expectedUserId) throw new Error("annotation_push_requires_user_owner");
    const response = await fetch(
      `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/annotations/push`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-same-page-owner-user-id": expectedUserId,
        },
        body: JSON.stringify({ operations: batch.map(toWireOperation) }),
      },
    );
    if (!response.ok) throw new AnnotationPushError(response.status);
    const body = (await response.json()) as {
      results: Array<{
        opId: string;
        status: "accepted" | "conflict" | "op_id_reused";
        object?: AnnotationObjectRecord | null;
      }>;
    };
    await assertLocalWorkspaceActive(workspace);
    await applyPushResults(workspace, batch, body.results);
    pushed += batch.length;
  }
  return pushed;
}

function authenticatedUserId(workspace: LocalWorkspace) {
  return workspace.ownerKey.startsWith("user:")
    ? workspace.ownerKey.slice("user:".length)
    : null;
}

export async function withScoreSyncLock<T>(
  workspace: LocalWorkspace,
  action: () => Promise<T>,
) {
  const scopeKey = workspace.scopeKey;
  if (navigator.locks) {
    return navigator.locks.request(`same-page:sync:${scopeKey}`, action);
  }
  const owner = crypto.randomUUID();
  const acquired = await withLocalWorkspaceTransaction(
    workspace,
    "rw",
    [localDatabase.syncLeases],
    async () => {
      const current = await localDatabase.syncLeases.get(scopeKey);
      if (current && current.expiresAt > Date.now()) return false;
      await localDatabase.syncLeases.put({
        ...workspace,
        lockOwner: owner,
        expiresAt: Date.now() + 120_000,
      });
      return true;
    },
  );
  if (!acquired) return undefined;
  try {
    return await action();
  } finally {
    await withLocalWorkspaceTransaction(
      workspace,
      "rw",
      [localDatabase.syncLeases],
      async () => {
        const current = await localDatabase.syncLeases.get(scopeKey);
        if (current?.lockOwner === owner) {
          await localDatabase.syncLeases.delete(scopeKey);
        }
      },
    ).catch((error: unknown) => {
      if (!(error instanceof LocalWorkspaceOwnerChangedError)) throw error;
    });
  }
}

function toWireOperation(operation: AnnotationOutboxRecord) {
  assertOutboxOperation(operation);
  return {
    opId: operation.opId,
    annotationId: operation.annotationId,
    layerId: operation.layerId,
    baseVersion: operation.baseVersion,
    type: operation.type,
    payload: operation.payload,
  };
}

function assertOutboxOperation(operation: AnnotationOutboxRecord) {
  if (operation.baseVersion === 0 && operation.type === "delete") {
    throw new Error("annotation_outbox_invariant_version_zero_delete");
  }
}
