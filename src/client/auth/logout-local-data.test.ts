import { beforeEach, describe, expect, it } from "vitest";

import {
  annotationRecordKey,
  localDatabase,
} from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
  localWorkspaceRecordKey,
  currentLocalOwnerKey,
} from "../platform/local-workspace";
import {
  clearPrivateLocalDataAfterLogout,
  getLogoutLocalSummary,
} from "./logout-local-data";

beforeEach(async () => {
  await localDatabase.open();
  await Promise.all([
    localDatabase.annotationLayers.clear(),
    localDatabase.annotations.clear(),
    localDatabase.annotationOutbox.clear(),
    localDatabase.annotationConflicts.clear(),
    localDatabase.offlineScores.clear(),
    localDatabase.system.clear(),
  ]);
  await activateAuthenticatedLocalOwner("user-1");
});

describe("logout local privacy", () => {
  it("warns about unsynchronized work and removes private data after confirmation", async () => {
    const workspace = createLocalWorkspace(
      authenticatedLocalOwnerKey("user-1"),
      "choir-1",
      "score-1",
    );
    const scopeKey = workspace.scopeKey;
    const sharedLayer = {
      key: localWorkspaceRecordKey(workspace, "shared-layer"),
      ...workspace,
      id: "shared-layer",
      kind: "shared" as const,
      defaultSlot: null,
      name: "指挥",
      sortOrder: 0,
      defaultColor: "#112233",
      colorOverride: "#445566",
      visible: false,
      canEdit: true,
    };
    const personalLayer = {
      ...sharedLayer,
      key: localWorkspaceRecordKey(workspace, "personal-layer"),
      id: "personal-layer",
      kind: "personal" as const,
      name: "我的批注",
    };
    await localDatabase.annotationLayers.bulkPut([sharedLayer, personalLayer]);
    const annotation = (
      id: string,
      layerId: string,
      state: "synced" | "pending" | "sync-error",
    ) => ({
      key: annotationRecordKey(scopeKey, id),
      ...workspace,
      id,
      layerId,
      version: 1,
      baseVersion: 1,
      deleted: false,
      payload: {
        kind: "text" as const,
        pageNumber: 1,
        x: 0.1,
        y: 0.2,
        text: id,
      },
      state,
      lastOpId: null,
      syncErrorCode: state === "sync-error" ? ("op_id_reused" as const) : null,
      updatedAt: 1,
    });
    const sharedSynced = annotation("shared-synced", sharedLayer.id, "synced");
    const sharedPending = annotation("shared-pending", sharedLayer.id, "pending");
    const sharedSyncError = annotation(
      "shared-sync-error",
      sharedLayer.id,
      "sync-error",
    );
    const personalSynced = annotation("personal-synced", personalLayer.id, "synced");
    const orphanSynced = annotation("orphan-synced", "missing-layer", "synced");
    await localDatabase.annotations.bulkPut([
      sharedSynced,
      sharedPending,
      sharedSyncError,
      personalSynced,
      orphanSynced,
    ]);
    await localDatabase.annotationOutbox.put({
      opId: "op-1",
      ...workspace,
      annotationId: sharedPending.id,
      layerId: sharedLayer.id,
      baseVersion: 1,
      type: "upsert",
      payload: sharedPending.payload,
      attemptedAt: null,
      createdAt: 1,
    });
    await localDatabase.annotationConflicts.put({
      opId: "conflict-1",
      ...workspace,
      annotationId: personalSynced.id,
      layerId: personalLayer.id,
      localPayload: personalSynced.payload,
      localDeleted: false,
      canonical: null,
      createdAt: 1,
    });
    await localDatabase.offlineScores.put({
      key: "offline-1",
      ...workspace,
      versionId: "version-1",
      fileName: "离线乐谱.pdf",
      sha256: "a".repeat(64),
      pageCount: 1,
      blob: new Blob(["pdf"]),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: {
        layers: [sharedLayer, personalLayer],
        annotations: [sharedSynced, personalSynced, orphanSynced],
        cursor: 2,
        verifiedAt: 1,
      },
    });

    await expect(getLogoutLocalSummary()).resolves.toEqual({
      pendingOperations: 1,
      conflicts: 1,
      syncErrors: 1,
    });
    await clearPrivateLocalDataAfterLogout();

    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(await localDatabase.annotationConflicts.count()).toBe(0);
    expect((await localDatabase.annotationLayers.toArray())).toEqual([
      expect.objectContaining({
        id: sharedLayer.id,
        canEdit: false,
        visible: true,
        colorOverride: null,
      }),
    ]);
    expect((await localDatabase.annotations.toArray()).map((entry) => entry.id)).toEqual([
      sharedSynced.id,
    ]);
    const offline = await localDatabase.offlineScores.toCollection().first();
    expect(offline?.ownerKey).toMatch(/^guest:/);
    expect(offline?.annotationSnapshot.layers.map((layer) => layer.id)).toEqual([
      sharedLayer.id,
    ]);
    expect(
      offline?.annotationSnapshot.annotations.map((entry) => entry.id),
    ).toEqual([sharedSynced.id]);
    expect(await currentLocalOwnerKey()).toBeNull();
    expect(
      await localDatabase.annotationLayers.where("ownerKey").equals(workspace.ownerKey).count(),
    ).toBe(0);
  });
});
