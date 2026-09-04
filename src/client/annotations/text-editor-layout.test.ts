import { describe, expect, it } from "vitest";

import { calculateTextEditorLayout } from "./text-editor-layout";

describe("calculateTextEditorLayout", () => {
  it("keeps large text inside a reduced visual viewport", () => {
    expect(calculateTextEditorLayout({
      fontSize: 96,
      contentHeight: 900,
      viewportHeight: 220,
      viewportTop: 0,
      headerBottom: 44,
    })).toEqual({
      height: 76,
      overflowY: "auto",
    });
  });
});
