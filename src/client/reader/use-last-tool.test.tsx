import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLastTool } from "./use-last-tool";
import { useToolStyle } from "./use-tool-style";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it("restores explicit choices and their separate styles across mounts, isolating owners", () => {
  const hook = renderHook(({ owner }) => {
    const choice = useLastTool(owner);
    return { ...choice, ...useToolStyle(owner, choice.tool) };
  }, { initialProps: { owner: "user:one" } });
  expect(hook.result.current.tool).toBe("text");
  expect(localStorage.getItem("note-last-tool:user:one")).toBeNull();
  act(() => hook.result.current.setTool("highlighter"));
  act(() => hook.result.current.setStyle({ ...hook.result.current.style, opacity: .6 }));
  act(() => hook.result.current.setTool("text"));
  act(() => hook.result.current.setTool("highlighter"));
  expect(hook.result.current.style.opacity).toBe(.6);
  hook.rerender({ owner: "guest:drive" });
  expect(hook.result.current.tool).toBe("text");
  act(() => hook.result.current.setTool("eraser"));
  hook.rerender({ owner: "user:two" });
  expect(hook.result.current.tool).toBe("text");
  hook.rerender({ owner: "user:one" });
  expect(hook.result.current.tool).toBe("highlighter");
  hook.unmount();
  expect(renderHook(() => useLastTool("user:one")).result.current.tool).toBe("highlighter");
});
it("falls back on invalid or unreadable storage and retains a choice when writing fails", () => {
  localStorage.setItem("note-last-tool:user:one", "invalid");
  expect(renderHook(() => useLastTool("user:one")).result.current.tool).toBe("text");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  const hook = renderHook(() => useLastTool("user:two"));
  expect(hook.result.current.tool).toBe("text");
  act(() => hook.result.current.setTool("ellipse"));
  expect(hook.result.current.tool).toBe("ellipse");
});
