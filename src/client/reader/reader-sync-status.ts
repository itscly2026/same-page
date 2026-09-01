import type { AnnotationConflictRecord } from "../platform/local-database";

export type ReaderSyncOutcome =
  | "none"
  | "local-draft"
  | "local-saved"
  | "synced"
  | "failed"
  | "trash-preserved"
  | "conflict-discarded"
  | "conflict-reapplied";

export type ReaderSyncStatusKind =
  | "quiet"
  | "draft"
  | "pending"
  | "syncing"
  | "failed"
  | "conflict"
  | "risk";

export interface ReaderSyncStatus {
  kind: ReaderSyncStatusKind;
  message: string | null;
}

export function deriveReaderSyncStatus({
  outcome,
  syncing,
  pendingCount,
  conflictCount,
  syncErrorCount,
}: {
  outcome: ReaderSyncOutcome;
  syncing: boolean;
  pendingCount: number;
  conflictCount: number;
  syncErrorCount: number;
}): ReaderSyncStatus {
  if (outcome === "trash-preserved") {
    return {
      kind: "risk",
      message: "乐谱已移入回收站；本机内容仍保留，恢复后才能继续同步。",
    };
  }
  if (conflictCount > 0) {
    return {
      kind: "conflict",
      message: `仍有 ${conflictCount} 项本机冲突待处理。`,
    };
  }
  if (syncErrorCount > 0 || outcome === "failed") {
    return {
      kind: "failed",
      message:
        syncErrorCount > 0
          ? `${syncErrorCount} 项批注同步失败；本机版本仍然保留，请重试。`
          : "同步未完成；本机内容仍然保留，请重试。",
    };
  }
  if (syncing) return { kind: "syncing", message: "正在同步批注…" };
  if (pendingCount > 0 || outcome === "local-saved") {
    return {
      kind: "pending",
      message:
        pendingCount > 0
          ? `已保存在本机，${pendingCount} 项等待同步。`
          : "已保存在本机，联网后会继续同步。",
    };
  }
  if (outcome === "local-draft") {
    return { kind: "draft", message: "编辑内容已持续保存在本机。" };
  }
  if (outcome === "conflict-discarded") {
    return { kind: "quiet", message: "已放弃本机冲突版本。" };
  }
  if (outcome === "conflict-reapplied") {
    return { kind: "quiet", message: "冲突处理已同步。" };
  }
  return { kind: "quiet", message: null };
}

export function describeAnnotationConflict(
  conflict: AnnotationConflictRecord,
  layerName: string,
) {
  const payload = conflict.localPayload ?? conflict.canonical?.payload ?? null;
  const pageNumber = payload?.pageNumber ?? 1;
  let summary = "批注内容";
  if (conflict.localDeleted) {
    summary = "删除批注";
  } else if (payload?.kind === "text") {
    summary = truncateSummary(payload.text);
  } else if (payload?.kind === "ink") {
    summary = `笔迹 · ${payload.points.length} 个点`;
  }
  return { pageNumber, layerName, summary };
}

function truncateSummary(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "空文字批注";
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
}
