import {
  annotationPullResponseSchema,
  type AnnotationObjectRecord,
} from "../../shared/annotations";
import {
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

export async function drainAnnotationOutbox(workspace: LocalWorkspace) {
  await assertLocalWorkspaceActive(workspace);
  let pushed = 0;
  while (true) {
    const batch = await withLocalWorkspaceTransaction(
      workspace,
      "rw",
      [localDatabase.annotationOutbox],
      async () => {
        const operations = await localDatabase.annotationOutbox
          .where("scopeKey")
          .equals(workspace.scopeKey)
          .sortBy("createdAt");
        const seenAnnotationIds = new Set<string>();
        const selected = operations
          .filter((operation) => {
            if (seenAnnotationIds.has(operation.annotationId)) return false;
            seenAnnotationIds.add(operation.annotationId);
            return true;
          })
          .slice(0, 100);
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
    if (!response.ok) throw new Error("annotation_push_failed");
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
  return {
    opId: operation.opId,
    annotationId: operation.annotationId,
    layerId: operation.layerId,
    baseVersion: operation.baseVersion,
    type: operation.type,
    payload: operation.payload,
  };
}
