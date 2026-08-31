export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function uploadMessage(status: number, payload: unknown) {
  const error = (payload as { error?: string } | null)?.error;
  if (status === 413 || error === "pdf_too_large") return "PDF 超过 20 MB。";
  if (error === "encrypted_pdf") return "加密 PDF 不能上传。";
  if (error === "invalid_pdf") return "PDF 已损坏或无法解析。";
  if (error === "filename_conflict") {
    return "文件库已有同名文件。请重命名，或在原文件上执行替换 PDF。";
  }
  if (error === "invalid_file_name") return "文件名无效。";
  if (error === "storage_quota_exceeded") return "云盘的 1 GB 文件配额已用完。";
  if (error === "replacement_in_progress") return "另一项 PDF 替换正在进行，请稍后再试。";
  return "操作没有完成，现有文件保持不变。";
}
