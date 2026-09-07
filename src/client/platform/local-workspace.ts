import { readLogoutFence } from "../auth/logout-fence";
import type { Table } from "dexie";

import {
  ACTIVE_LOCAL_OWNER_KEY,
  guestOwnerSystemKey,
  LAST_AUTHENTICATED_OWNER_KEY,
  localDatabase,
} from "./local-database";

declare const localWorkspaceOwnerBrand: unique symbol;
export type LocalWorkspaceOwnerKey = string & {
  readonly [localWorkspaceOwnerBrand]: true;
};

export interface LocalWorkspace {
  readonly ownerKey: LocalWorkspaceOwnerKey;
  readonly choirId: string;
  readonly scoreId: string;
  readonly scopeKey: string;
  readonly sessionEpoch?: string;
  readonly syncLockToken?: string;
}

export class LocalWorkspaceOwnerChangedError extends Error {
  constructor() {
    super("local_workspace_owner_changed");
  }
}

export function authenticatedLocalOwnerKey(
  userId: string,
): LocalWorkspaceOwnerKey {
  return `user:${userId}` as LocalWorkspaceOwnerKey;
}

export async function activateAuthenticatedLocalOwner(userId: string, signal?: AbortSignal) {
  const ownerKey = authenticatedLocalOwnerKey(userId);
  await localDatabase.transaction("rw", localDatabase.system, async () => {
    const fence = await readLogoutFence();
    if (fence && fence.userId === userId) throw new LocalWorkspaceOwnerChangedError();
    const currentOwner = await currentLocalOwnerKey();
    signal?.throwIfAborted();
    if (currentOwner !== ownerKey) {
      await localDatabase.system.put({ key: "local-workspace:epoch", value: crypto.randomUUID() });
    }
    await localDatabase.system.bulkPut([
      { key: LAST_AUTHENTICATED_OWNER_KEY, value: ownerKey },
      { key: ACTIVE_LOCAL_OWNER_KEY, value: ownerKey },
    ]);
  });
  return ownerKey;
}

export async function resolveLocalWorkspace(options: {
  authenticatedUserId: string | null;
  signal?: AbortSignal;
  choirId: string;
  scoreId: string;
}): Promise<LocalWorkspace> {
  const ownerKey = options.authenticatedUserId
    ? await activateAuthenticatedLocalOwner(options.authenticatedUserId, options.signal)
    : await resolveOfflineOwner(options.choirId, options.signal);
  return createLocalWorkspace(ownerKey, options.choirId, options.scoreId);
}

export function createLocalWorkspace(
  ownerKey: LocalWorkspaceOwnerKey,
  choirId: string,
  scoreId: string,
): LocalWorkspace {
  return {
    ownerKey,
    choirId,
    scoreId,
    scopeKey: JSON.stringify([ownerKey, choirId, scoreId]),
  };
}

export function localWorkspaceRecordKey(
  workspace: LocalWorkspace,
  recordId: string,
) {
  return JSON.stringify([workspace.scopeKey, recordId]);
}

export async function captureLocalWorkspaceSession(workspace: LocalWorkspace): Promise<LocalWorkspace> {
  return withLocalWorkspaceTransaction(workspace, "r", [], async () => ({
    ...workspace,
    sessionEpoch: (await localDatabase.system.get("local-workspace:epoch"))?.value ?? "",
  }));
}

export async function assertLocalWorkspaceActive(workspace: LocalWorkspace) {
  if (!(await isLocalWorkspaceActive(workspace)) ||
      (workspace.sessionEpoch !== undefined && workspace.sessionEpoch !== ((await localDatabase.system.get("local-workspace:epoch"))?.value ?? "")) ||
      (workspace.syncLockToken !== undefined && workspace.syncLockToken !== (await localDatabase.system.get(`annotation-sync-fence:${workspace.scopeKey}`))?.value)) {
    throw new LocalWorkspaceOwnerChangedError();
  }
}

export async function isLocalWorkspaceActive(workspace: LocalWorkspace) {
  const activeOwner = await currentLocalOwnerKey();
  if (workspace.ownerKey.startsWith("user:")) {
    return activeOwner === workspace.ownerKey;
  }
  if (activeOwner?.startsWith("user:")) return false;
  const guestOwner = await localDatabase.system.get(
    guestOwnerSystemKey(workspace.choirId),
  );
  return guestOwner?.value === workspace.ownerKey;
}

export function withLocalWorkspaceTransaction<T>(
  workspace: LocalWorkspace,
  mode: "r" | "rw",
  tables: Table[],
  action: () => T | PromiseLike<T>,
) {
  return localDatabase.transaction(
    mode,
    [localDatabase.system, ...tables],
    async () => {
      await assertLocalWorkspaceActive(workspace);
      return action();
    },
  );
}

export async function currentLocalOwnerKey() {
  const record = await localDatabase.system.get(ACTIVE_LOCAL_OWNER_KEY);
  return (record?.value as LocalWorkspaceOwnerKey | undefined) ?? null;
}

export async function clearCurrentAuthenticatedLocalOwner() {
  const ownerKey = await currentLocalOwnerKey();
  if (!ownerKey?.startsWith("user:")) return null;
  await localDatabase.system.bulkDelete([
    LAST_AUTHENTICATED_OWNER_KEY,
    ACTIVE_LOCAL_OWNER_KEY,
    "local-workspace:epoch",
  ]);
  return ownerKey;
}

async function resolveOfflineOwner(choirId: string, signal?: AbortSignal) {
  return localDatabase.transaction("rw", localDatabase.system, async () => {
    const lastAuthenticated = await localDatabase.system.get(
      LAST_AUTHENTICATED_OWNER_KEY,
    );
    signal?.throwIfAborted();
    if (lastAuthenticated) {
      const ownerKey = lastAuthenticated.value as LocalWorkspaceOwnerKey;
      await localDatabase.system.put({
        key: ACTIVE_LOCAL_OWNER_KEY,
        value: ownerKey,
      });
      return ownerKey;
    }
    const key = guestOwnerSystemKey(choirId);
    const existing = await localDatabase.system.get(key);
    signal?.throwIfAborted();
    const ownerKey = existing
      ? (existing.value as LocalWorkspaceOwnerKey)
      : (`guest:${crypto.randomUUID()}` as LocalWorkspaceOwnerKey);
    await localDatabase.system.bulkPut([
      { key, value: ownerKey },
      { key: ACTIVE_LOCAL_OWNER_KEY, value: ownerKey },
    ]);
    return ownerKey;
  });
}
