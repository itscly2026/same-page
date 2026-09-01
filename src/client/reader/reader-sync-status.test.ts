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
  syncing: false,
  pendingCount: 0,
  conflictCount: 0,
  syncErrorCount: 0,
};

describe("reader sync status", () => {
  it("keeps no-change and successful states quiet", () => {
    expect(deriveReaderSyncStatus(quiet)).toEqual({ kind: "quiet", message: null });
    expect(
      deriveReaderSyncStatus({ ...quiet, outcome: "synced" }),
    ).toEqual({ kind: "quiet", message: null });
  });

  it("distinguishes durable pending work, failures and true conflicts", () => {
    expect(
      deriveReaderSyncStatus({ ...quiet, outcome: "local-saved", pendingCount: 2 }),
    ).toEqual({ kind: "pending", message: "已保存在本机，2 项等待同步。" });
    expect(
      deriveReaderSyncStatus({ ...quiet, outcome: "failed" }),
    ).toMatchObject({ kind: "failed" });
    expect(
      deriveReaderSyncStatus({ ...quiet, outcome: "failed", conflictCount: 1 }),
    ).toEqual({ kind: "conflict", message: "仍有 1 项本机冲突待处理。" });
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
        text: "这是一条很长的批注文字，用来确认摘要不会无限暴露完整内容。",
      },
      localDeleted: false,
      canonical: null,
      createdAt: 1,
    } satisfies AnnotationConflictRecord;

    expect(describeAnnotationConflict(conflict, "G")).toEqual({
      pageNumber: 7,
      layerName: "G",
      summary: "这是一条很长的批注文字，用来确认摘要不会无限暴露完整内容…",
    });
  });
});
