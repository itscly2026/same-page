import { trialMessage } from "../drives/trial-messages";
export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function uploadMessage(status: number, payload: unknown) {
  const error = (payload as { error?: string } | null)?.error;
  if (status === 413 || error === "pdf_too_large") return "PDF 超过 20 MB。";
  if (error === "pdf_resource_limit") return "PDF 超过解析资源限制（最多 500 页），请拆分后上传。";
  if (error === "version_conflict") return "当前版本已变化或所选版本已到期，请关闭后重新预览。";
  if (error === "encrypted_pdf") return "加密 PDF 不能上传。";
  if (error === "invalid_pdf") return "PDF 已损坏或无法解析。";
  if (error === "filename_conflict") {
    return "文件库已有同名文件。请重命名，或在原文件上执行替换 PDF。";
  }
  if (error === "invalid_file_name") return "文件名无效。";
  if (error === "storage_quota_exceeded") return "云盘剩余空间不足，请联系拥有者清理回收站或历史 PDF 后重试。";
  if (error === "platform_storage_limit_reached" || error === "score_limit_reached" || error === "try_again_later" || error === "resource_deleted") return trialMessage(error);
  if (error === "replacement_in_progress") return "另一项 PDF 替换正在进行，请稍后再试。";
  return "操作没有完成，现有文件保持不变。";
}
