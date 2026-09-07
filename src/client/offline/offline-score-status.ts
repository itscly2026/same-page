import type { OfflineScoreRecord } from "../platform/local-database";
import type { OfflinePreparationState } from "./offline-score";

// Preparing a replacement and possessing verified bytes are independent facts.
export function offlinePreparationDescription(preparation: OfflinePreparationState, copy: { record: OfflineScoreRecord | null; invalid: boolean } | null | undefined, versionId: string, mode?: "pdf" | "images") {
  if (preparation.phase === "preparing") return "正在下载并校验…";
  if (preparation.phase === "failed") {
    if (preparation.reason === "identity") return "请先登录，再准备新的离线副本。现有副本仍可使用。";
    return copy ? offlineDownloadFailure(copy.record, versionId, copy.invalid, mode) : "离线下载未完成，尚未确认本机副本，请重试校验。";
  }
  return copy ? offlineScoreLabel(copy.record, versionId, copy.invalid, mode) : "正在校验本机副本…";
}

function offlineScoreLabel(record: OfflineScoreRecord | null, currentVersionId: string, invalid = false, mode?: "pdf" | "images") {
  if (invalid) return "本地副本不可用，请重新下载";
  if (!record) return "尚未下载离线副本";
  if (mode && (record.imageManifest ? "images" : "pdf") !== mode) return `当前显示方式尚未下载 · ${record.imageManifest ? "图片" : "PDF"}副本可离线使用`;
  return record.versionId === currentVersionId ? "可离线使用" : "旧版可离线使用 · 新版待下载";
}

function offlineDownloadFailure(record: OfflineScoreRecord | null, currentVersionId: string, invalid = false, mode?: "pdf" | "images") {
  const prefix = "离线下载未完成。";
  if (invalid || !record) return `${prefix}当前乐谱尚不可离线使用，请联网重试。`;
  const format = record.imageManifest ? "图片" : "PDF";
  if (record.versionId !== currentVersionId) return `${prefix}旧版 ${format} 仍可离线使用，当前版本尚未准备好。`;
  if (mode && (record.imageManifest ? "images" : "pdf") !== mode) return `${prefix}${format} 副本仍可离线使用，当前显示方式尚未准备好。`;
  return `${prefix}当前 ${format} 仍可离线使用，现有副本不受影响。`;
}


