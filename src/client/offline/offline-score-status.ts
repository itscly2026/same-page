import type { OfflineScoreRecord } from "../platform/local-database";
import type { OfflinePreparationState } from "./offline-score";

const offlineAnnotationsUnavailable = "谱面已校验，笔记或访问权限未能确认，离线副本准备未完成。可继续在线阅读并重试。";

// Preparing a replacement and possessing verified bytes are independent facts.
export function offlinePreparationDescription(preparation: OfflinePreparationState, copy: { record: OfflineScoreRecord | null; invalid: boolean; readFailed?: boolean } | null | undefined, versionId: string, mode?: "pdf" | "images") {
  if (copy?.readFailed) return "暂时无法读取本机副本，请重试校验";
  if (preparation.phase === "preparing") return "正在准备并校验…";
  if (preparation.phase === "failed") {
    if (preparation.reason === "timeout") return "离线副本准备超时，尚未确认可离线使用。请重试，现有副本和本机笔记仍然保留。";
    if (preparation.reason === "annotations") return offlineAnnotationsUnavailable;
    if (preparation.reason === "identity") return "请先登录，再准备新的离线副本。现有副本仍可使用。";
    return copy ? offlineDownloadFailure(copy.record, versionId, copy.invalid, mode) : "离线准备未完成，尚未确认本机副本，请重试校验。";
  }
  return copy ? offlineScoreLabel(copy.record, versionId, copy.invalid, mode) : "正在校验本机副本…";
}

function offlineScoreLabel(record: OfflineScoreRecord | null, currentVersionId: string, invalid = false, mode?: "pdf" | "images") {
  if (invalid) return "本地副本不可用，请重新保存";
  if (!record) return "尚未保存供离线使用";
  if (mode && (record.imageManifest ? "images" : "pdf") !== mode) return `当前显示方式尚未保存 · ${record.imageManifest ? "图片" : "PDF"}副本可离线使用`;
  return record.versionId === currentVersionId ? "可离线使用" : "旧版可离线使用 · 新版待保存";
}

function offlineDownloadFailure(record: OfflineScoreRecord | null, currentVersionId: string, invalid = false, mode?: "pdf" | "images") {
  const prefix = "离线准备未完成。";
  if (invalid || !record) return `${prefix}当前乐谱尚不可离线使用，请联网重试。`;
  const format = record.imageManifest ? "图片" : "PDF";
  if (record.versionId !== currentVersionId) return `${prefix}旧版 ${format} 仍可离线使用，当前版本尚未准备好。`;
  if (mode && (record.imageManifest ? "images" : "pdf") !== mode) return `${prefix}${format} 副本仍可离线使用，当前显示方式尚未准备好。`;
  return `${prefix}当前 ${format} 仍可离线使用，现有副本不受影响。`;
}
