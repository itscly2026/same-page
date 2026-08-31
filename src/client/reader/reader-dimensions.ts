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
