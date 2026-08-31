import {
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

export async function activateAuthenticatedLocalOwner(userId: string) {
  const ownerKey = authenticatedLocalOwnerKey(userId);
  await localDatabase.system.put({
    key: LAST_AUTHENTICATED_OWNER_KEY,
    value: ownerKey,
  });
  return ownerKey;
}

export async function resolveLocalWorkspace(options: {
  authenticatedUserId: string | null;
  choirId: string;
  scoreId: string;
}): Promise<LocalWorkspace> {
  const ownerKey = options.authenticatedUserId
    ? await activateAuthenticatedLocalOwner(options.authenticatedUserId)
    : await resolveOfflineOwner(options.choirId);
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

export async function assertLocalWorkspaceActive(workspace: LocalWorkspace) {
  const activeOwner = await currentLocalOwnerKey();
  if (activeOwner !== workspace.ownerKey) {
    throw new LocalWorkspaceOwnerChangedError();
  }
}

export async function currentLocalOwnerKey() {
  const record = await localDatabase.system.get(LAST_AUTHENTICATED_OWNER_KEY);
  return (record?.value as LocalWorkspaceOwnerKey | undefined) ?? null;
}

export async function clearCurrentAuthenticatedLocalOwner() {
  const ownerKey = await currentLocalOwnerKey();
  if (!ownerKey?.startsWith("user:")) return null;
  await localDatabase.system.delete(LAST_AUTHENTICATED_OWNER_KEY);
  return ownerKey;
}

async function resolveOfflineOwner(choirId: string) {
  const lastAuthenticated = await currentLocalOwnerKey();
  if (lastAuthenticated) return lastAuthenticated;
  const key = guestOwnerSystemKey(choirId);
  const existing = await localDatabase.system.get(key);
  if (existing) return existing.value as LocalWorkspaceOwnerKey;
  const ownerKey = `guest:${crypto.randomUUID()}` as LocalWorkspaceOwnerKey;
  await localDatabase.system.put({ key, value: ownerKey });
  return ownerKey;
}
