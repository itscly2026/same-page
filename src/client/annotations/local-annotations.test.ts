import { beforeEach, describe, expect, it } from "vitest";

import type { AnnotationObjectRecord } from "../../shared/annotations";
import {
  annotationRecordKey,
  localDatabase,
} from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import {
  applyPushResults,
  cleanupUncreatedDeleteConflicts,
  queueScoreDrafts,
  reapplyAnnotationConflict,
  retryScoreSyncErrors,
  saveAnnotationDraft,
} from "./annotation-state";
import { beginAnnotationEditSession, saveDraftWithHistory, undoAnnotationEdit, redoAnnotationEdit } from "./annotation-state";
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
        y: 0.3, fontScale: 0.024,
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
        y: 0.3, fontScale: 0.024,
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

  it.each([false, true])("preserves unqueued B when A conflicts, keepBoth=%s", async (keepBoth) => {
    const id = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("A") });
    await queueScoreDrafts(workspace);
    const operation = (await localDatabase.annotationOutbox.toArray())[0]!;
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("B") });
    await applyPushResults(workspace, [operation], [{
      opId: operation.opId, status: "conflict", object: canonicalText(id, layerId, 2, "cloud"),
    }]);
    await reapplyAnnotationConflict(workspace, operation.opId, keepBoth);
    expect(await localDatabase.annotations.where("[scopeKey+state]").equals([workspace.scopeKey, "draft"]).toArray())
      .toEqual([expect.objectContaining({ payload: { ...textPayload("B") }, baseVersion: keepBoth ? 0 : 2 })]);
  });

  it("undoes content after confirmation without restoring pending metadata", async () => {
    const id = crypto.randomUUID(); const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("A") });
    await queueScoreDrafts(workspace);
    const a = (await localDatabase.annotationOutbox.toArray())[0]!;
    beginAnnotationEditSession();
    await saveDraftWithHistory(workspace, { id, layerId, payload: textPayload("B") });
    await applyPushResults(workspace, [a], [{ opId: a.opId, status: "accepted", object: canonicalText(id, layerId, 1, "A") }]);
    await undoAnnotationEdit(workspace, layerId);
    localDatabase.close(); await localDatabase.open();
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({ version: 1, baseVersion: 1, state: "draft", payload: { text: "A" } });
    await redoAnnotationEdit(workspace, layerId);
    await queueScoreDrafts(workspace);
    expect(await localDatabase.annotationOutbox.toArray()).toEqual([expect.objectContaining({ baseVersion: 1, payload: { ...textPayload("B") } })]);
  });

  it("ignores duplicate responses after a newer confirmation and retains edits made during a conflict", async () => {
    const id = crypto.randomUUID(); const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("A") });
    await queueScoreDrafts(workspace);
    const a = (await localDatabase.annotationOutbox.toArray())[0]!;
    await applyPushResults(workspace, [a], [{ opId: a.opId, status: "accepted", object: canonicalText(id, layerId, 1, "A") }]);
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("B") });
    await queueScoreDrafts(workspace);
    const b = (await localDatabase.annotationOutbox.toArray())[0]!;
    await applyPushResults(workspace, [b], [{ opId: b.opId, status: "conflict", object: canonicalText(id, layerId, 2, "cloud") }]);
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("C") });
    expect(await queueScoreDrafts(workspace)).toBe(0);
    await reapplyAnnotationConflict(workspace, b.opId);
    await applyPushResults(workspace, [a], [{ opId: a.opId, status: "accepted", object: canonicalText(id, layerId, 1, "A") }]);
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({ baseVersion: 2, payload: { text: "C" } });
  });

  it.each([false, true])("preserves deletion after an attempted A conflicts, keepBoth=%s", async keepBoth => {
    const id = crypto.randomUUID(), layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, { id, layerId, payload: textPayload("A") });
    await queueScoreDrafts(workspace);
    const a = (await localDatabase.annotationOutbox.toArray())[0]!;
    await localDatabase.annotationOutbox.update(a.opId, { attemptedAt: 1 });
    await saveAnnotationDraft(workspace, { id, layerId, payload: null, deleted: true });
    await applyPushResults(workspace, [a], [{ opId: a.opId, status: "conflict", object: canonicalText(id, layerId, 2, "cloud") }]);
    await reapplyAnnotationConflict(workspace, a.opId, keepBoth);
    await queueScoreDrafts(workspace);
    expect(await localDatabase.annotationConflicts.count()).toBe(0);
    if (keepBoth) {
      expect(await localDatabase.annotationOutbox.count()).toBe(0);
      expect(await localDatabase.annotations.toCollection().first()).toMatchObject({ state: "synced", payload: { text: "cloud" } });
    } else {
      expect(await localDatabase.annotationOutbox.toArray()).toEqual([expect.objectContaining({ baseVersion: 2, type: "delete" })]);
    }
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
        y: 0.3, fontScale: 0.024,
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
      fontScale: 0.024,
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

  it("folds a never-uploaded create followed by delete into no local or network work", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: textPayload("临时文字"),
    });
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: null,
      deleted: true,
    });

    expect(await queueScoreDrafts(workspace)).toBe(0);
    expect(await localDatabase.annotations.count()).toBe(0);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);

    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: textPayload("已排队但未尝试"),
    });
    expect(await queueScoreDrafts(workspace)).toBe(1);
    const create = (await localDatabase.annotationOutbox.toArray())[0]!;
    expect(create).toMatchObject({ baseVersion: 0, type: "upsert", attemptedAt: null });

    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: null,
      deleted: true,
    });
    expect(await localDatabase.annotations.count()).toBe(0);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
  });

  it("keeps an attempted create idempotent and queues delete only after a positive version", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: textPayload("已发出的新建"),
    });
    await queueScoreDrafts(workspace);
    const create = (await localDatabase.annotationOutbox.toArray())[0]!;
    await localDatabase.annotationOutbox.update(create.opId, { attemptedAt: 1 });

    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: null,
      deleted: true,
    });
    expect(await queueScoreDrafts(workspace)).toBe(1);
    expect(await localDatabase.annotationOutbox.toArray()).toEqual([
      expect.objectContaining({
        opId: create.opId,
        baseVersion: 0,
        type: "upsert",
        attemptedAt: 1,
      }),
    ]);

    await applyPushResults(workspace, [create], [
      {
        opId: create.opId,
        status: "accepted",
        object: canonicalText(annotationId, layerId, 1, "已发出的新建"),
      },
    ]);
    const deleteOperation = (await localDatabase.annotationOutbox.toArray())[0]!;
    expect(deleteOperation).toMatchObject({
      annotationId,
      baseVersion: 1,
      type: "delete",
      payload: null,
      attemptedAt: null,
    });
    expect(
      (await localDatabase.annotationOutbox.toArray()).some(
        (operation) => operation.baseVersion === 0 && operation.type === "delete",
      ),
    ).toBe(false);
  });

  it("recovers an accepted create response after restart with the original opId", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: textPayload("响应丢失"),
    });
    await queueScoreDrafts(workspace);
    const create = (await localDatabase.annotationOutbox.toArray())[0]!;
    await localDatabase.annotationOutbox.update(create.opId, { attemptedAt: 1 });
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: null,
      deleted: true,
    });

    localDatabase.close();
    await localDatabase.open();
    expect((await localDatabase.annotationOutbox.toArray())[0]?.opId).toBe(create.opId);
    await applyPushResults(workspace, [create], [
      {
        opId: create.opId,
        status: "accepted",
        object: canonicalText(annotationId, layerId, 1, "响应丢失"),
      },
    ]);
    expect(await localDatabase.annotationOutbox.toArray()).toEqual([
      expect.objectContaining({ baseVersion: 1, type: "delete" }),
    ]);
  });

  it("cleans only canonical-empty version-zero delete conflicts", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    const key = annotationRecordKey(workspace.scopeKey, annotationId);
    await localDatabase.annotations.put({
      key,
      ...workspace,
      id: annotationId,
      layerId,
      version: 0,
      baseVersion: 0,
      deleted: true,
      payload: null,
      state: "conflict",
      lastOpId: "pseudo-conflict",
      syncErrorCode: null,
      updatedAt: 1,
    });
    await localDatabase.annotationConflicts.put({
      opId: "pseudo-conflict",
      ...workspace,
      annotationId,
      layerId,
      localPayload: null,
      localDeleted: true,
      canonical: null,
      createdAt: 1,
    });
    const realId = crypto.randomUUID();
    const realKey = annotationRecordKey(workspace.scopeKey, realId);
    const canonical = canonicalText(realId, layerId, 2, "云端对象");
    await localDatabase.annotations.put({
      key: realKey,
      ...workspace,
      id: realId,
      layerId,
      version: 1,
      baseVersion: 1,
      deleted: true,
      payload: null,
      state: "conflict",
      lastOpId: "real-conflict",
      syncErrorCode: null,
      updatedAt: 1,
    });
    await localDatabase.annotationConflicts.put({
      opId: "real-conflict",
      ...workspace,
      annotationId: realId,
      layerId,
      localPayload: null,
      localDeleted: true,
      canonical,
      createdAt: 1,
    });

    expect(await cleanupUncreatedDeleteConflicts(workspace)).toBe(1);
    expect(await localDatabase.annotations.get(key)).toBeUndefined();
    expect(await localDatabase.annotationConflicts.get("pseudo-conflict")).toBeUndefined();
    expect(await localDatabase.annotations.get(realKey)).toBeDefined();
    expect(await localDatabase.annotationConflicts.get("real-conflict")).toBeDefined();
  });
});

function textPayload(text: string) {
  return {
    kind: "text" as const,
    pageNumber: 1,
    x: 0.2,
    y: 0.3,
    fontScale: 0.024,
    text,
  };
}

function canonicalText(
  id: string,
  layerId: string,
  version: number,
  text: string,
): AnnotationObjectRecord {
  return {
    id,
    layerId,
    version,
    deleted: false,
    payload: textPayload(text),
    createdByDisplayName: "我",
    updatedByDisplayName: "我",
    updatedAt: version,
  };
}
