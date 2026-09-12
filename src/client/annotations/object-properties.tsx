import { X } from "lucide-react";
import { useState } from "react";
import type { AnnotationPayload } from "../../shared/annotations";
import { StyleFields } from "./style-fields";
import { defaultToolStyle } from "./tool-style";
export function ObjectProperties({ payload, personal, displayColor, onApply, onClose, onEditText, onDelete }: {
  payload: AnnotationPayload; personal: boolean; displayColor?: string;
  onApply(payload: AnnotationPayload): Promise<boolean>; onClose(): void; onEditText(): void; onDelete(): void;
}) {
  const tool = payload.kind === "ink" ? payload.brush === "highlighter" ? "highlighter" : "ink" : payload.kind === "shape" ? payload.shape : "text";
  const [style, setStyle] = useState({ ...defaultToolStyle(tool), ...payload });
  const [color, setColor] = useState(payload.color ?? "#dc2626");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const apply = async () => {
    setSaving(true);
    const next = { ...payload, ...(personal ? { color } : {}), ...(payload.kind === "text" ? { fontScale: style.fontScale, textAlign: style.textAlign } : { strokeWidth: style.strokeWidth }), ...(payload.kind === "ink" ? { nib: style.nib, opacity: style.opacity, pressureMode: style.pressureMode } : {}) };
    const saved = await onApply(next);
    setSaving(false); setFailed(!saved);
    if (saved) onClose();
  };
  return <aside className="annotation-object-properties" aria-label="所选笔记属性">
    <header><h2>所选笔记</h2><button type="button" className="icon-button" aria-label="关闭所选笔记属性" onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
    <p>修改当前对象，可撤销。</p>
    <fieldset disabled={saving}><div style={{ color: personal ? color : displayColor }}><StyleFields tool={tool} value={style} onChange={value => setStyle({ ...style, ...value })} /></div>
    {personal && <label className="annotation-object-color">颜色<input aria-label="所选笔记颜色" type="color" value={color} onChange={event => setColor(event.target.value)} /></label>}
    <footer>{payload.kind === "text" && <button type="button" onClick={onEditText}>编辑文字</button>}<button type="button" onClick={onDelete}>删除</button><button type="button" className="primary-button" onClick={() => void apply()}>应用修改</button></footer></fieldset>
    {failed && <p role="alert">尚未保存，请重试本机保存。</p>}
  </aside>;
}
