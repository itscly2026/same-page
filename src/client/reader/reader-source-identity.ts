export function readerPdfSourceIsCurrent(
  failedSource: object,
  currentSource: object | null,
) {
  return failedSource === currentSource;
}
