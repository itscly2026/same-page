const TEXT_EDITOR_MINIMUM_LINES = 2;
const TEXT_EDITOR_LINE_HEIGHT = 1.25;
const TEXT_EDITOR_VERTICAL_INSET_PX = 72;
const TEXT_EDITOR_HEADER_GAP_PX = 12;

export function calculateTextEditorLayout({
  fontSize,
  contentHeight,
  viewportHeight,
  viewportTop,
  headerBottom,
}: {
  fontSize: number;
  contentHeight: number;
  viewportHeight: number;
  viewportTop: number;
  headerBottom: number;
}) {
  const minimumHeight = Math.ceil(
    fontSize * TEXT_EDITOR_LINE_HEIGHT * TEXT_EDITOR_MINIMUM_LINES,
  );
  const verticalInset = Math.max(
    TEXT_EDITOR_VERTICAL_INSET_PX,
    Math.ceil(headerBottom - viewportTop + TEXT_EDITOR_HEADER_GAP_PX),
  );
  const maximumHeight = Math.max(
    0,
    Math.floor(viewportHeight - verticalInset * 2),
  );
  const minimumVisibleHeight = Math.min(minimumHeight, maximumHeight);

  return {
    height: Math.min(
      maximumHeight,
      Math.max(minimumVisibleHeight, contentHeight),
    ),
    overflowY: contentHeight > maximumHeight ? "auto" : "hidden",
  } as const;
}
