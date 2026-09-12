import { z } from "zod";
import type { AnnotationTool } from "./annotation-overlay";
export const toolStyleSchema = z.object({
  nib: z.enum(["round", "chisel"]),
  strokeWidth: z.number().finite().min(0.001).max(0.06),
  opacity: z.number().finite().min(0.05).max(1),
  pressureMode: z.enum(["uniform", "pressure"]),
  textAlign: z.enum(["left", "center", "right"]).default("center"),
  fontScale: z.number().finite().min(0.012).max(0.08),
});
export type ToolStyle = z.infer<typeof toolStyleSchema>;
export function defaultToolStyle(tool: AnnotationTool): ToolStyle {
  return { nib: tool === "highlighter" ? "chisel" : "round", strokeWidth: tool === "highlighter" ? 0.018 : 0.003, opacity: tool === "highlighter" ? 0.3 : 1, pressureMode: "uniform", fontScale: 0.016, textAlign: "center" };
}
