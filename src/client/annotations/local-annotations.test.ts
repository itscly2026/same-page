import { beforeEach, describe, expect, it } from "vitest";

import type { AnnotationObjectRecord } from "../../shared/annotations";
import { localDatabase } from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import {
  applyPushResults,
  queueScoreDrafts,
  reapplyAnnotationConflict,
  retryScoreSyncErrors,
  saveAnnotationDraft,
} from "./local-annotations";
import { withScoreSyncLock } from "./sync";

beforeEach(async () => {
  await localDatabase.open();
  await Promise.all([
    localDatabase.annotations.clear(),
    localDatabase.annotationOutbox.clear(),
    localDatabase.annotationConflicts.clear(),
    localDatabase.annotationSyncCursors.clear(),
    localDatabase.syncLeases.clear(),
    localDatabase.system.clear(),
  ]);
  await activateAuthenticatedLocalOwner("user-1");
});

const workspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);

describe("local annotation durability", () => {
  it("persists drafts before queueing and keeps a rejected variant only on this device", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.2,
        y: 0.3,
        text: "本机修改",
      },
    });

    localDatabase.close();
    await localDatabase.open();
    expect(
      await localDatabase.annotations
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .first(),
    ).toMatchObject({ state: "draft", payload: { text: "本机修改" } });

    expect(await queueScoreDrafts(workspace)).toBe(1);
    const operation = (await localDatabase.annotationOutbox.toArray())[0]!;
    const canonical: AnnotationObjectRecord = {
      id: annotationId,
      layerId,
      version: 2,
      deleted: false,
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.2,
        y: 0.3,
        text: "云端版本",
      },
      createdByDisplayName: "甲",
      updatedByDisplayName: "乙",
      updatedAt: 10,
    };
    await applyPushResults(workspace, [operation], [
      { opId: operation.opId, status: "conflict", object: canonical },
    ]);

    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(await localDatabase.annotationConflicts.get(operation.opId)).toMatchObject({
      localPayload: { text: "本机修改" },
      canonical: { payload: { text: "云端版本" } },
    });
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
      state: "conflict",
      payload: { text: "本机修改" },
    });

    await reapplyAnnotationConflict(workspace, operation.opId);
    expect(await localDatabase.annotationConflicts.count()).toBe(0);
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
      state: "draft",
      baseVersion: 2,
      payload: { text: "本机修改" },
    });
  });

  it("allows only one fallback lease holder to drain a score at a time", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withScoreSyncLock(workspace, async () => {
      await held;
      return "first";
    });
    await Promise.resolve();
    const second = await withScoreSyncLock(workspace, async () => "second");
    expect(second).toBeUndefined();
    release();
    await expect(first).resolves.toBe("first");
  });

  it("keeps an operation-id reuse as a retryable sync error, not an edit conflict", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.2,
        y: 0.3,
        text: "本机修改",
      },
    });
    await queueScoreDrafts(workspace);
    const operation = (await localDatabase.annotationOutbox.toArray())[0]!;

    await applyPushResults(workspace, [operation], [
      { opId: operation.opId, status: "op_id_reused" },
    ]);

    expect(await localDatabase.annotationConflicts.count()).toBe(0);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
      state: "sync-error",
      syncErrorCode: "op_id_reused",
      payload: { text: "本机修改" },
    });

    expect(await retryScoreSyncErrors(workspace)).toBe(1);
    expect(await queueScoreDrafts(workspace)).toBe(1);
    const retried = (await localDatabase.annotationOutbox.toArray())[0]!;
    expect(retried.opId).not.toBe(operation.opId);
  });

  it("serializes repeated local edits to one object and advances the later base version", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    const payload = (text: string) => ({
      kind: "text" as const,
      pageNumber: 1,
      x: 0.1,
      y: 0.1,
      text,
    });
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: payload("第一次"),
    });
    await queueScoreDrafts(workspace);
    const first = (await localDatabase.annotationOutbox.toArray())[0]!;
    await localDatabase.annotationOutbox.update(first.opId, { attemptedAt: 1 });

    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: payload("第二次"),
    });
    await queueScoreDrafts(workspace);
    const queued = await localDatabase.annotationOutbox.orderBy("createdAt").toArray();
    const second = queued.find((operation) => operation.opId !== first.opId)!;
    expect(second.baseVersion).toBe(0);

    await applyPushResults(workspace, [first], [
      {
        opId: first.opId,
        status: "accepted",
        object: {
          id: annotationId,
          layerId,
          version: 1,
          deleted: false,
          payload: payload("第一次"),
          createdByDisplayName: "我",
          updatedByDisplayName: "我",
          updatedAt: 2,
        },
      },
    ]);
    expect(await localDatabase.annotationOutbox.get(second.opId)).toMatchObject({
      baseVersion: 1,
      payload: { text: "第二次" },
    });
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
      version: 1,
      baseVersion: 1,
      state: "pending",
      payload: { text: "第二次" },
    });
  });
});
