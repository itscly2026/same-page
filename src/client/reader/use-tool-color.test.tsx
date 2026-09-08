import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { AnnotationTool } from "../annotations/annotation-overlay";
import { useToolColor } from "./use-tool-color";

it("remembers independent tools across reopening and isolates users", () => {
  localStorage.clear();
  const hook = renderHook(({ owner, tool }: { owner: string; tool: AnnotationTool }) => useToolColor(owner, tool), { initialProps: { owner: "user:one", tool: "text" as AnnotationTool } });
  expect(hook.result.current.color).toBe("#dc2626");
  act(() => hook.result.current.setColor("#123456"));
  hook.rerender({ owner: "user:one", tool: "ink" });
  expect(hook.result.current.color).toBe("#dc2626");
  act(() => hook.result.current.setColor("#654321"));
  hook.rerender({ owner: "user:one", tool: "highlighter" });
  expect(hook.result.current.color).toBe("#facc15");
  hook.rerender({ owner: "user:one", tool: "rectangle" });
  expect(hook.result.current.color).toBe("#dc2626");
  act(() => hook.result.current.setColor("#112233"));
  hook.rerender({ owner: "user:one", tool: "ellipse" });
  expect(hook.result.current.color).toBe("#112233");
  hook.rerender({ owner: "user:two", tool: "text" });
  expect(hook.result.current.color).toBe("#dc2626");
  hook.unmount();
  const reopened = renderHook(() => useToolColor("user:one", "text"));
  expect(reopened.result.current.color).toBe("#123456");
});
