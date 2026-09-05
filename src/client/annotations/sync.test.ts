import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TEXT_FONT_SCALE } from "../../shared/annotations";
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
  queueScoreDrafts,
  saveAnnotationDraft,
} from "./annotation-state";
import { pushPendingAnnotations, syncAnnotations } from "./sync";

const workspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

describe("bounded annotation push", () => {
  beforeEach(async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, _options: LockOptions, action: (lock: object) => Promise<unknown>) => action({}),
      },
    });
    await localDatabase.open();
    await activateAuthenticatedLocalOwner("user-1");
    await Promise.all([
      localDatabase.annotations.clear(),
      localDatabase.annotationOutbox.clear(),
      localDatabase.annotationConflicts.clear(),
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalLocks) {
      Object.defineProperty(navigator, "locks", originalLocks);
    } else {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
    }
  });

  it("pulls readable cloud changes even when push is forbidden", async () => {
    const id = crypto.randomUUID(), layerId = crypto.randomUUID();
    await saveAnnotationDraft(workspace, { id, layerId, payload: { kind: "text", pageNumber: 1, x: .1, y: .2, fontScale: .024, text: "local" } });
    await queueScoreDrafts(workspace);
    const cloudId = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => init?.method === "POST"
      ? Response.json({}, { status: 403 })
      : Response.json({ cursor: 7, objects: [{ id: cloudId, layerId, version: 1, deleted: false, payload: { kind: "text", pageNumber: 1, x: .1, y: .2, fontScale: .024, text: "cloud" }, createdByDisplayName: "", updatedByDisplayName: "", updatedAt: 1 }] })));
    await expect(syncAnnotations(workspace, { pull: true })).rejects.toThrow();
    expect(await localDatabase.annotations.get(annotationRecordKey(workspace.scopeKey, cloudId))).toMatchObject({ state: "synced" });
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });

  it("returns busy immediately when another tab holds the Web Lock", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: {
      request: async (_name: string, options: LockOptions, action: (lock: null) => Promise<unknown>) => {
        expect(options.ifAvailable).toBe(true);
        return action(null);
      },
    }});
    await expect(pushPendingAnnotations(workspace, { maxOperations: 100 })).resolves.toBeUndefined();
  });

  it("leaves work beyond the application recovery limit for a later trigger", async () => {
    await localDatabase.annotationOutbox.bulkPut(
      Array.from({ length: 101 }, (_, index) => ({
        opId: `op-${index}`,
        ...workspace,
        annotationId: `annotation-${index}`,
        layerId: "layer-1",
        baseVersion: 0,
        type: "upsert" as const,
        payload: {
          kind: "text" as const,
          pageNumber: 1,
          x: 0.1,
          y: 0.2,
          fontScale: DEFAULT_TEXT_FONT_SCALE,
          text: String(index),
        },
        attemptedAt: null,
        createdAt: index,
      })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          operations: Array<{ opId: string }>;
        };
        return Response.json({
          results: body.operations.map(({ opId }) => ({
            opId,
            status: "op_id_reused",
          })),
        });
      }),
    );

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).resolves.toBe(100);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });

  it("drains an attempted create before its deferred positive-version delete", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    const payload = {
      kind: "text" as const,
      pageNumber: 1,
      x: 0.1,
      y: 0.2,
      fontScale: DEFAULT_TEXT_FONT_SCALE,
      text: "短暂存在",
    };
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload,
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
    await queueScoreDrafts(workspace);

    const sent: Array<{
      opId: string;
      baseVersion: number;
      type: "upsert" | "delete";
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          operations: typeof sent;
        };
        const operation = body.operations[0]!;
        sent.push(operation);
        return Response.json({
          results: [
            operation.type === "upsert"
              ? {
                  opId: operation.opId,
                  status: "accepted",
                  object: {
                    id: annotationId,
                    layerId,
                    version: 1,
                    deleted: false,
                    payload,
                    createdByDisplayName: "我",
                    updatedByDisplayName: "我",
                    updatedAt: 1,
                  },
                }
              : {
                  opId: operation.opId,
                  status: "accepted",
                  object: {
                    id: annotationId,
                    layerId,
                    version: 2,
                    deleted: true,
                    payload: null,
                    createdByDisplayName: "我",
                    updatedByDisplayName: "我",
                    updatedAt: 2,
                  },
                },
          ],
        });
      }),
    );

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).resolves.toBe(2);
    expect(sent).toEqual([
      expect.objectContaining({
        opId: create.opId,
        baseVersion: 0,
        type: "upsert",
      }),
      expect.objectContaining({ baseVersion: 1, type: "delete" }),
    ]);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(await localDatabase.annotationConflicts.count()).toBe(0);
    expect(await localDatabase.annotations.toCollection().first()).toMatchObject({
      version: 2,
      deleted: true,
      state: "synced",
    });
  });

  it("replays the original create opId after an accepted response is lost and the app restarts", async () => {
    const annotationId = crypto.randomUUID();
    const layerId = crypto.randomUUID();
    const payload = {
      kind: "text" as const,
      pageNumber: 1,
      x: 0.1,
      y: 0.2,
      fontScale: DEFAULT_TEXT_FONT_SCALE,
      text: "服务端已接受",
    };
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload,
    });
    await queueScoreDrafts(workspace);
    const create = (await localDatabase.annotationOutbox.toArray())[0]!;
    const sent: Array<{
      opId: string;
      baseVersion: number;
      type: "upsert" | "delete";
    }> = [];
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          operations: typeof sent;
        };
        const operation = body.operations[0]!;
        sent.push(operation);
        requestCount += 1;
        if (requestCount === 1) {
          throw new TypeError("response_lost_after_accept");
        }
        return Response.json({
          results: [
            operation.type === "upsert"
              ? {
                  opId: operation.opId,
                  status: "accepted",
                  object: {
                    id: annotationId,
                    layerId,
                    version: 1,
                    deleted: false,
                    payload,
                    createdByDisplayName: "我",
                    updatedByDisplayName: "我",
                    updatedAt: 1,
                  },
                }
              : {
                  opId: operation.opId,
                  status: "accepted",
                  object: {
                    id: annotationId,
                    layerId,
                    version: 2,
                    deleted: true,
                    payload: null,
                    createdByDisplayName: "我",
                    updatedByDisplayName: "我",
                    updatedAt: 2,
                  },
                },
          ],
        });
      }),
    );

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).rejects.toThrow("response_lost_after_accept");
    expect(await localDatabase.annotationOutbox.get(create.opId)).toMatchObject({
      attemptedAt: expect.any(Number),
    });
    await saveAnnotationDraft(workspace, {
      id: annotationId,
      layerId,
      payload: null,
      deleted: true,
    });
    await queueScoreDrafts(workspace);
    localDatabase.close();
    await localDatabase.open();

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).resolves.toBe(2);
    expect(sent).toEqual([
      expect.objectContaining({ opId: create.opId, type: "upsert" }),
      expect.objectContaining({ opId: create.opId, type: "upsert" }),
      expect.objectContaining({ baseVersion: 1, type: "delete" }),
    ]);
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
    expect(await localDatabase.annotationConflicts.count()).toBe(0);
  });

  it("folds a legacy version-zero delete without poisoning other outbox work", async () => {
    await localDatabase.annotationOutbox.put({
      opId: "legacy-invalid-delete",
      ...workspace,
      annotationId: "annotation-1",
      layerId: "layer-1",
      baseVersion: 0,
      type: "delete",
      payload: null,
      attemptedAt: null,
      createdAt: 1,
    });
    await localDatabase.annotationOutbox.put({
      opId: "valid-create",
      ...workspace,
      annotationId: "annotation-2",
      layerId: "layer-1",
      baseVersion: 0,
      type: "upsert",
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.1,
        y: 0.2,
        fontScale: DEFAULT_TEXT_FONT_SCALE,
        text: "不应被阻断",
      },
      attemptedAt: null,
      createdAt: 2,
    });
    const send = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        send();
        const body = JSON.parse(String(init?.body)) as {
          operations: Array<{ opId: string }>;
        };
        return Response.json({
          results: body.operations.map(({ opId }) => ({
            opId,
            status: "op_id_reused",
          })),
        });
      }),
    );

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).resolves.toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(
      await localDatabase.annotationOutbox.get("legacy-invalid-delete"),
    ).toBeUndefined();
    expect(await localDatabase.annotationOutbox.count()).toBe(0);
  });

  it("does not remove a separate positive-version conflict while folding an invalid delete", async () => {
    const annotationId = "annotation-with-real-conflict";
    const layerId = "layer-1";
    await localDatabase.annotations.put({
      key: annotationRecordKey(workspace.scopeKey, annotationId),
      ...workspace,
      id: annotationId,
      layerId,
      version: 2,
      baseVersion: 2,
      deleted: true,
      payload: null,
      state: "conflict",
      lastOpId: "positive-version-conflict",
      syncErrorCode: null,
      updatedAt: 1,
    });
    await localDatabase.annotationConflicts.put({
      opId: "positive-version-conflict",
      ...workspace,
      annotationId,
      layerId,
      localPayload: null,
      localDeleted: true,
      canonical: null,
      createdAt: 1,
    });
    await localDatabase.annotationOutbox.put({
      opId: "unrelated-invalid-delete",
      ...workspace,
      annotationId,
      layerId,
      baseVersion: 0,
      type: "delete",
      payload: null,
      attemptedAt: null,
      createdAt: 2,
    });

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).resolves.toBe(0);
    expect(await localDatabase.annotationConflicts.get("positive-version-conflict"))
      .toMatchObject({ localDeleted: true, canonical: null });
    expect(
      await localDatabase.annotations.get(
        annotationRecordKey(workspace.scopeKey, annotationId),
      ),
    ).toMatchObject({ version: 2, state: "conflict" });
  });
});
