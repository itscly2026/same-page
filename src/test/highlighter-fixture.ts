import type { AnnotationPayload } from "../shared/annotations";

// Reduced from the seed-1, 40-point reproduction of #296.
export function regressionHighlighter(): Extract<AnnotationPayload, { kind: "ink" }> {
  return { kind: "ink", brush: "highlighter", nib: "chisel", pressureMode: "uniform",
    pageNumber: 2, strokeWidth: .012, opacity: .3, points: [{"x": 0.2975474471172318, "y": 0.39983101687510497, "pressure": 0.5, "twist": 0}, {"x": 0.29979602489210666, "y": 0.39999958258681, "pressure": 0.5, "twist": 0}, {"x": 0.29749498430639504, "y": 0.40041732070618313, "pressure": 0.5, "twist": 0}, {"x": 0.3001088787926361, "y": 0.401026399403112, "pressure": 0.5, "twist": 0}, {"x": 0.29651103996410966, "y": 0.40110478075616995, "pressure": 0.5, "twist": 0}, {"x": 0.29760836253929884, "y": 0.4007427180539817, "pressure": 0.5, "twist": 0}, {"x": 0.32473842509463424, "y": 0.39984347981587065, "pressure": 0.5, "twist": 0}] };
}
