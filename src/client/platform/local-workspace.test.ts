import Dexie from "dexie";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_LAST_AUTHENTICATED_USER_ID_KEY,
  localDatabase,
} from "./local-database";
import {
  activateAuthenticatedLocalOwner,
  assertLocalWorkspaceActive,
  resolveLocalWorkspace,
} from "./local-workspace";

const legacyStores = {
  system: "&key",
  offlineScores: "&key,[choirId+scoreId],versionId,active,verifiedAt",
  annotations: "&key,scopeKey,[scopeKey+layerId],[scopeKey+state],id,updatedAt",
  annotationOutbox: "&opId,scopeKey,[scopeKey+annotationId],createdAt",
  annotationConflicts: "&opId,scopeKey,[scopeKey+annotationId],createdAt",
  annotationSyncCursors: "&scopeKey",
  guestLayerPreferences: "&key,scopeKey,[scopeKey+layerId]",
  syncLeases: "&scopeKey,expiresAt",
  annotationLayers: "&key,scopeKey,[scopeKey+id],kind,sortOrder",
};

describe("local workspace migration", () => {
  it("clears legacy private records even when the previous user is reliable", async () => {
    await seedLegacyDatabase("user-1");

    await localDatabase.open();

    expect(await localDatabase.annotations.count()).toBe(0);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(await localDatabase.offlineScores.count()).toBe(0);
  });

  it("clears legacy shared offline content when no owner is reliable", async () => {
    await seedLegacyDatabase(null);

    await localDatabase.open();

    expect(await localDatabase.offlineScores.count()).toBe(0);
    expect(await localDatabase.annotations.count()).toBe(0);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
  });

  it("retries atomically after an interrupted migration", async () => {
    await seedLegacyDatabase(null);
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockImplementationOnce(() => {
        throw new Error("interrupted");
      });

    await expect(localDatabase.open()).rejects.toThrow("interrupted");
    localDatabase.close();
    randomUuid.mockRestore();
    await expect(localDatabase.open()).resolves.toBe(localDatabase);
    expect(await localDatabase.offlineScores.count()).toBe(0);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
  });

  it("opens an empty legacy database without manufacturing content", async () => {
    const legacy = new Dexie("same-page");
    legacy.version(4).stores(legacyStores);
    await legacy.open();
    legacy.close();

    await localDatabase.open();

    expect(await localDatabase.offlineScores.count()).toBe(0);
    expect(await localDatabase.annotations.count()).toBe(0);
  });
});

describe("local workspace identity transitions", () => {
  beforeEach(async () => {
    await localDatabase.open();
    await localDatabase.system.clear();
    await localDatabase.annotations.clear();
  });

  it("restores A after session expiry and rejects A after B becomes active", async () => {
    const a = await resolveLocalWorkspace({
      authenticatedUserId: "user-a",
      choirId: "choir-1",
      scoreId: "score-1",
    });
    const expired = await resolveLocalWorkspace({
      authenticatedUserId: null,
      choirId: "choir-1",
      scoreId: "score-1",
    });
    expect(expired.ownerKey).toBe(a.ownerKey);
    await expect(assertLocalWorkspaceActive(a)).resolves.toBeUndefined();

    const b = await resolveLocalWorkspace({
      authenticatedUserId: "user-b",
      choirId: "choir-1",
      scoreId: "score-1",
    });
    expect(b.ownerKey).not.toBe(a.ownerKey);
    await expect(assertLocalWorkspaceActive(a)).rejects.toThrow(
      "local_workspace_owner_changed",
    );
  });

  it("does not promote a guest workspace when the guest signs in", async () => {
    const guest = await resolveLocalWorkspace({
      authenticatedUserId: null,
      choirId: "choir-1",
      scoreId: "score-1",
    });
    await expect(assertLocalWorkspaceActive(guest)).resolves.toBeUndefined();
    await localDatabase.annotations.put({
      ...guest,
      key: JSON.stringify([guest.scopeKey, "guest-draft"]),
      id: "guest-draft",
      layerId: "shared",
      version: 0,
      baseVersion: 0,
      deleted: false,
      payload: null,
      state: "draft",
      lastOpId: null,
      syncErrorCode: null,
      updatedAt: 1,
    });

    const user = await resolveLocalWorkspace({
      authenticatedUserId: "user-1",
      choirId: "choir-1",
      scoreId: "score-1",
    });

    expect(user.ownerKey).not.toBe(guest.ownerKey);
    expect(
      await localDatabase.annotations.where("scopeKey").equals(user.scopeKey).count(),
    ).toBe(0);
  });

  it("invalidates an old tab as soon as another tab activates B", async () => {
    const a = await resolveLocalWorkspace({
      authenticatedUserId: "user-a",
      choirId: "choir-1",
      scoreId: "score-1",
    });
    await activateAuthenticatedLocalOwner("user-b");

    await expect(assertLocalWorkspaceActive(a)).rejects.toThrow(
      "local_workspace_owner_changed",
    );
  });

  it("keeps two guest choir workspaces active until a user signs in", async () => {
    const first = await resolveLocalWorkspace({
      authenticatedUserId: null,
      choirId: "choir-1",
      scoreId: "score-1",
    });
    const second = await resolveLocalWorkspace({
      authenticatedUserId: null,
      choirId: "choir-2",
      scoreId: "score-2",
    });

    await expect(assertLocalWorkspaceActive(first)).resolves.toBeUndefined();
    await expect(assertLocalWorkspaceActive(second)).resolves.toBeUndefined();
    await activateAuthenticatedLocalOwner("user-1");
    await expect(assertLocalWorkspaceActive(first)).rejects.toThrow(
      "local_workspace_owner_changed",
    );
    await expect(assertLocalWorkspaceActive(second)).rejects.toThrow(
      "local_workspace_owner_changed",
    );
  });
});

async function seedLegacyDatabase(userId: string | null) {
  localDatabase.close();
  await localDatabase.delete();
  const legacy = new Dexie("same-page");
  legacy.version(4).stores(legacyStores);
  await legacy.open();
  const scopeKey = "choir-1:score-1";
  if (userId) {
    await legacy.table("system").put({
      key: LEGACY_LAST_AUTHENTICATED_USER_ID_KEY,
      value: userId,
    });
  }
  const sharedLayer = legacyLayer(scopeKey, "shared", "shared");
  const personalLayer = legacyLayer(scopeKey, "personal", "personal");
  const sharedAnnotation = legacyAnnotation(
    scopeKey,
    "shared-synced",
    "shared",
    "synced",
  );
  const privateDraft = legacyAnnotation(
    scopeKey,
    "private-draft",
    "personal",
    "draft",
  );
  await legacy.table("annotationLayers").bulkPut([sharedLayer, personalLayer]);
  await legacy.table("annotations").bulkPut(
    userId ? [privateDraft] : [sharedAnnotation, privateDraft],
  );
  await legacy.table("annotationOutbox").put({
    opId: "legacy-op",
    scopeKey,
    choirId: "choir-1",
    scoreId: "score-1",
    annotationId: "private-draft",
    layerId: "personal",
    baseVersion: 0,
    type: "upsert",
    payload: null,
    attemptedAt: null,
    createdAt: 1,
  });
  await legacy.table("offlineScores").put({
    key: "legacy-offline",
    choirId: "choir-1",
    scoreId: "score-1",
    versionId: "version-1",
    fileName: "score.pdf",
    sha256: "a".repeat(64),
    pageCount: 1,
    blob: new Blob(["pdf"]),
    active: 1,
    verifiedAt: 1,
    annotationSnapshot: {
      layers: [sharedLayer, personalLayer],
      annotations: [sharedAnnotation, privateDraft],
      cursor: 2,
      verifiedAt: 1,
    },
  });
  legacy.close();
}

function legacyLayer(scopeKey: string, id: string, kind: "shared" | "personal") {
  return {
    key: `${scopeKey}:${id}`,
    scopeKey,
    id,
    kind,
    defaultSlot: null,
    name: id,
    sortOrder: kind === "shared" ? 0 : 10_000,
    subscribed: false,
    subscriptionSource: "product",
    displayColor: "#445566",
    colorSource: "product",
    adminDefaultColor: "#112233",
    driveSubscribed: null,
    driveColorOverride: null,
    scoreSubscriptionOverride: null,
    canEdit: true,
  };
}

function legacyAnnotation(
  scopeKey: string,
  id: string,
  layerId: string,
  state: "synced" | "draft",
) {
  return {
    key: `${scopeKey}:${id}`,
    scopeKey,
    choirId: "choir-1",
    scoreId: "score-1",
    id,
    layerId,
    version: state === "synced" ? 1 : 0,
    baseVersion: state === "synced" ? 1 : 0,
    deleted: false,
    payload: null,
    state,
    lastOpId: null,
    syncErrorCode: null,
    updatedAt: 1,
  };
}
