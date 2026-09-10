import { describe, expect, it } from "vitest";

import type { AnnotationConflictRecord } from "../platform/local-database";
import {
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import {
  deriveReaderSyncStatus,
  describeAnnotationConflict,
} from "./reader-sync-status";

const quiet = {
  outcome: "none" as const,
  loaded: true,
  syncing: false,
  pendingCount: 0,
  conflictCount: 0,
  syncErrorCount: 0,
};

describe("reader sync status", () => {
  it("distinguishes an explicit completed sync from untouched local state", () => {
    expect(deriveReaderSyncStatus({ ...quiet, loaded: false }).message).toContain("尚未确认");
    expect(deriveReaderSyncStatus({ ...quiet, outcome: "synced" }).message).toBe("已同步");
    expect(deriveReaderSyncStatus({ ...quiet, acceptedCount: 2 }).message).toBe("已同步");
  });

  it("distinguishes local persistence, queued work and real requests", () => {
    expect(deriveReaderSyncStatus({ ...quiet, draftCount: 1 }).message).toBe("已保存在本机 · 完成编辑后同步");
    expect(deriveReaderSyncStatus({ ...quiet, pendingCount: 2, online: false }).message).toBe("已保存在本机 · 等待联网");
    expect(deriveReaderSyncStatus({ ...quiet, pendingCount: 2, syncing: true }).message).toBe("正在同步 2 项修改");
    expect(deriveReaderSyncStatus({ ...quiet, pendingCount: 1, acceptedCount: 2 }).kind).toBe("pending");
  });

  it("keeps conflicts and revoked grants actionable even during other sync", () => {
    expect(deriveReaderSyncStatus({ ...quiet, conflictCount: 1, syncing: true }).kind).toBe("conflict");
    expect(deriveReaderSyncStatus({ ...quiet, syncErrorCount: 1, permissionErrorCount: 1 }).message).toContain("编辑权已撤销");
    expect(deriveReaderSyncStatus({ ...quiet, outcome: "failed" }).message).toContain("查看原因或重试");
  });

  it("describes a persisted conflict by page, layer and a safe summary", () => {
    const workspace = createLocalWorkspace(
      authenticatedLocalOwnerKey("user-1"),
      "choir-1",
      "score-1",
    );
    const conflict = {
      opId: "op-1",
      ...workspace,
      annotationId: "annotation-1",
      layerId: "layer-1",
      localPayload: {
        kind: "text",
        pageNumber: 7,
        x: 0.1,
        y: 0.2,
        fontScale: 0.024,
        text: "这是一条很长的笔记文字，用来确认摘要不会无限暴露完整内容。",
      },
      localDeleted: false,
      canonical: null,
      createdAt: 1,
    } satisfies AnnotationConflictRecord;

    expect(describeAnnotationConflict(conflict, "G")).toEqual({
      pageNumber: 7,
      layerName: "G",
      summary: "这是一条很长的笔记文字，用来确认摘要不会无限暴露完整内容…",
    });
  });
});
