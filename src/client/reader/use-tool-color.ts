import { useState } from "react";
import type { AnnotationTool } from "../annotations/annotation-overlay";

export function useToolColor(ownerKey: string, tool: AnnotationTool) {
  const group = tool === "rectangle" || tool === "ellipse" ? "shape" : tool;
  const key = `note-tool-color:${ownerKey}:${group}`;
  const fallback = tool === "highlighter" ? "#facc15" : "#dc2626";
  const read = () => {
    try { const value = localStorage.getItem(key); return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback; }
    catch { return fallback; }
  };
  const [state, setState] = useState(() => ({ key, color: read() }));
  const color = state.key === key ? state.color : read();
  const setColor = (value: string) => {
    setState({ key, color: value });
    try { localStorage.setItem(key, value); } catch { /* Color remains usable for this editing session. */ }
  };
  return { color, setColor };
}
