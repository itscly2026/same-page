export function calculateFittedPageWidth(
  viewportWidth: number,
  viewportHeight: number,
  pageRatio: number,
) {
  return Math.max(
    1,
    Math.min(Math.max(1, viewportWidth), Math.max(1, viewportHeight) * pageRatio),
  );
}

export function calculatePageTurnDistance(
  pageWidth: number,
  gutterWidth: number,
) {
  return Math.max(1, pageWidth) + Math.max(0, gutterWidth);
}
