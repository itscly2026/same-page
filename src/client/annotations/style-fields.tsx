import { AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import { useState } from "react";
import { inkSvgPaths } from "./ink-geometry";
import { Button, Label, Slider, SliderOutput, SliderThumb, SliderTrack } from "react-aria-components";
import type { AnnotationTool } from "./annotation-overlay";
import type { ToolStyle } from "./tool-style";
export function StyleFields({ tool, value, onChange }: { tool: AnnotationTool; value: ToolStyle; onChange(value: ToolStyle): void }) {
  return <div className="annotation-style-fields">
    {tool === "text" ? <><TextSizeField value={value.fontScale} onChange={fontScale => onChange({ ...value, fontScale })} /><TextAlignment value={value.textAlign} onChange={textAlign => onChange({ ...value, textAlign })} /></> : <StyleSlider label={tool === "highlighter" ? "荧光笔宽度" : "线条粗细"} value={value.strokeWidth * 1000} min={1} max={tool === "highlighter" ? 60 : 20} onChange={strokeWidth => onChange({ ...value, strokeWidth: strokeWidth / 1000 })} />}
    {tool === "highlighter" && <StyleSlider label="不透明度" value={Math.round(value.opacity * 100)} min={5} max={100} suffix="%" onChange={opacity => onChange({ ...value, opacity: opacity / 100 })} />}
    {tool === "highlighter" && <div className="annotation-pressure-options" role="group" aria-label="荧光笔笔头">{(["round", "chisel"] as const).map(nib => <Button key={nib} aria-pressed={value.nib === nib} onPress={() => onChange({ ...value, nib })}>{nib === "round" ? "圆头" : "扁头"}</Button>)}</div>}
    {tool === "ink" && <div className="annotation-pressure-options" role="group" aria-label="笔迹模式">{(["uniform", "pressure"] as const).map(mode => <Button key={mode} aria-pressed={value.pressureMode === mode} onPress={() => onChange({ ...value, pressureMode: mode })}>{mode === "uniform" ? "等宽" : "压感"}</Button>)}</div>}
    <svg className="annotation-style-sample" viewBox="0 0 240 52" aria-label="样式预览">
      {tool === "text" ? <text x="12" y="36" fontSize={value.fontScale * 700} fill="currentColor">渐弱，留意指挥</text> : tool === "highlighter" ? <g transform="scale(.24 .052)">{inkSvgPaths({ kind: "ink", brush: "highlighter", nib: value.nib, pressureMode: "uniform", strokeWidth: value.strokeWidth * 2, pageNumber: 1, points: Array.from({ length: 16 }, (_, i) => ({ x: .1 + i * .053, y: .5 + Math.sin(i / 3) * .12 })) }, 240 / 52).map((path, index) => <path key={index} d={path} fill="currentColor" opacity={value.opacity} fillRule="evenodd" />)}</g> : <path d="M16 30 Q60 8 108 28 T224 22" fill="none" stroke="currentColor" strokeWidth={value.strokeWidth * 700} opacity={1} strokeLinecap="round" />}
    </svg>
  </div>;
}
function StyleSlider({ label, value, min, max, suffix = "", onChange }: { label: string; value: number; min: number; max: number; suffix?: string; onChange(value: number): void }) {
  return <Slider value={value} minValue={min} maxValue={max} step={1} onChange={value => onChange(value as number)} className="annotation-style-slider">
    <Label>{label}</Label><SliderOutput>{({ state }) => `${Math.round(state.values[0]!)}${suffix}`}</SliderOutput>
    <SliderTrack>{({ state }) => <><div className="annotation-style-fill" style={{ width: `${state.getThumbPercent(0) * 100}%` }} /><SliderThumb /></>}</SliderTrack>
  </Slider>;
}

export function TextSizeField({ value, onChange }: { value: number; onChange(value: number): void }) {
  return <div className="annotation-text-size-field">
    <StyleSlider label="字号" value={Math.min(32, value * 1000)} min={12} max={32} onChange={next => onChange(next / 1000)} />
    <TextSizeInput value={value} onChange={onChange} />
  </div>;
}
export function TextAlignment({ value, onChange }: { value: "left" | "center" | "right"; onChange(value: "left" | "center" | "right"): void }) {
  return <div className="annotation-pressure-options annotation-text-alignment" role="group" aria-label="文字对齐">
    {(["left", "center", "right"] as const).map(align => <Button key={align} aria-label={{ left: "左对齐", center: "居中", right: "右对齐" }[align]} aria-pressed={value === align} onPress={() => onChange(align)}>{align === "left" ? <AlignLeft size={20} /> : align === "right" ? <AlignRight size={20} /> : <AlignCenter size={20} />}</Button>)}
  </div>;
}

export function TextSizeInput({ value, onChange, disabled, className }: { value: number; onChange(value: number): void; disabled?: boolean; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return <input aria-label="字号数值" type="number" min={12} max={80} step={1} disabled={disabled} className={className} data-visible
    value={draft ?? Math.round(value * 1000)}
    onFocus={() => setDraft(String(Math.round(value * 1000)))}
    onChange={event => {
      setDraft(event.target.value);
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next) && next >= 12 && next <= 80) onChange(Math.round(next) / 1000);
    }}
    onBlur={() => {
      const next = draft?.trim() ? Number(draft) : NaN;
      if (Number.isFinite(next)) onChange(Math.min(80, Math.max(12, Math.round(next))) / 1000);
      setDraft(null);
    }} />;
}
