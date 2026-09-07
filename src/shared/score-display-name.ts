/** Presentation only; filename identity and download names retain their extension. */
export function scoreDisplayName(fileName: string) {
  return fileName.replace(/\.pdf$/i, "") || fileName;
}

export function scorePdfFileName(name: string) {
  const trimmed = name.trim();
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`;
}
