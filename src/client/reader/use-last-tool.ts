import { useState } from "react";
import type { AnnotationTool } from "../annotations/annotation-overlay";

const tools: readonly AnnotationTool[] = ["select", "text", "ink", "highlighter", "rectangle", "ellipse", "eraser"];
export function useLastTool(owner: string) {
  const key = `note-last-tool:${owner}`;
  const read = (): AnnotationTool => {
    try {
      const saved = localStorage.getItem(key);
      return tools.find(tool => tool === saved) ?? "text";
    } catch { return "text"; }
  };
  const [state, setState] = useState(() => ({ key, tool: read() }));
  if (state.key !== key) setState({ key, tool: read() });
  const setTool = (tool: AnnotationTool) => {
    setState({ key, tool });
    try { localStorage.setItem(key, tool); } catch { /* Optional local preference. */ }
  };
  return { tool: state.key === key ? state.tool : read(), setTool };
}
