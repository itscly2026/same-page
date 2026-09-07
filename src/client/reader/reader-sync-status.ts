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
  outcome, syncing, pendingCount, conflictCount, syncErrorCount,
  loaded = false, draftCount = 0, acceptedCount = 0, online = true,
  permissionErrorCount = 0,
}: {
  outcome: ReaderSyncOutcome;
  syncing: boolean;
  pendingCount: number;
  conflictCount: number;
  syncErrorCount: number;
  loaded?: boolean;
  draftCount?: number;
  acceptedCount?: number;
  online?: boolean;
  permissionErrorCount?: number;
}): ReaderSyncStatus {
  if (outcome === "trash-preserved") return { kind: "risk", message: "乐谱已移入回收站；本机内容仍保留，恢复后才能继续同步。" };
  if (!loaded) return { kind: "risk", message: "尚未确认本机批注状态，请稍后重试。" };
  if (conflictCount > 0) return { kind: "conflict", message: `仍有 ${conflictCount} 项本机冲突待处理。` };
  if (permissionErrorCount > 0) return { kind: "failed", message: `${permissionErrorCount} 项批注暂缓同步：层已停用、删除或编辑权已撤销。本机草稿保留；原层恢复且权限允许后重试。到期内容仍保留在本机，不会转写同名新层。其它批注会继续同步。` };
  if (syncErrorCount > 0 || outcome === "failed") return { kind: "failed", message: "同步未完成；已保存的本机草稿保留，请查看原因或重试。" };
  if (syncing) return { kind: "syncing", message: pendingCount > 0 ? `正在同步 ${pendingCount} 项修改` : "正在检查云端批注…" };
  if (pendingCount > 0 || draftCount > 0) return {
    kind: "pending",
    message: !online ? "已保存在本机 · 等待联网" : draftCount > 0 ? "已保存在本机 · 完成编辑后同步" : `已保存在本机 · ${pendingCount} 项等待同步`,
  };
  // A completed request, empty query or network connection is not acceptance.
  if (acceptedCount > 0) return { kind: "quiet", message: "已同步" };
  return { kind: "quiet", message: "尚无批注修改" };
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
