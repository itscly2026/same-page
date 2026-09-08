import { useUnsavedChanges } from "./use-unsaved-changes";
import { useRef, useState } from "react";
import type { SharedLayerManagementSummary } from "../../shared/annotations";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { runSettingsMutation, settingsMutationMessage } from "./settings-mutation";
import { useSettingsLifetime } from "./use-settings-lifetime";

export function SharedLayerDetailsForm({ choirId, layer, onSaved }: {
  choirId: string; layer: SharedLayerManagementSummary; onSaved(layer: SharedLayerManagementSummary): void;
}) {
  const [name, setName] = useState(layer.name);
  const [color, setColor] = useState(layer.defaultColor);
  const [active, setActive] = useState(layer.active);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; failed?: boolean } | null>(null);
  const busy = useRef(false);
  const generation = useSettingsLifetime();
  const dirty = name.trim() !== layer.name || color !== layer.defaultColor || active !== layer.active;
  const discard = () => { setName(layer.name); setColor(layer.defaultColor); setActive(layer.active); };
  const save = async () => {
    if (busy.current || !name.trim()) return false;
    const lifetime = generation.current;
    busy.current = true; setPending(true); setFeedback({ message: "正在保存…" });
    const changes = { name: name.trim(), defaultColor: color, active };
    const result = await runSettingsMutation(() => diagnosticFetch(`/api/choirs/${choirId}/shared-layers/${layer.slot}/settings`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changes),
    }));
    if (lifetime !== generation.current) return false;
    if (result.kind === "saved") onSaved({ ...layer, ...changes });
    setFeedback({ message: settingsMutationMessage(result, "共享层设置已保存。"), failed: result.kind !== "saved" });
    busy.current = false; setPending(false);
    return result.kind === "saved";
  };
  const exitDialog = useUnsavedChanges({ dirty, save, discard });
  return <form className="settings-card layer-details-form" aria-label="共享层设置" onSubmit={event => { event.preventDefault(); void save(); }}>
    {exitDialog}<p role="status">{dirty ? "未保存" : "所有修改已保存"}</p>
    <p className="settings-copy">此云盘所有成员的默认；个人显示覆盖仍保留。</p>
    <label>名称<input type="text" value={name} required maxLength={60} disabled={pending} onChange={event => setName(event.target.value)} /></label>
    <label className="settings-color-control">云盘默认颜色<input type="color" value={color} disabled={pending} onChange={event => setColor(event.target.value)} /></label>
    <label className="layer-active-toggle"><input type="checkbox" checked={active} disabled={pending} onChange={event => setActive(event.target.checked)} />启用此共享层</label>
    <p className="settings-copy">停用后隐藏笔记并暂停编辑，笔记和授权保留。</p>
    <button className="primary-button" disabled={pending || !dirty || !name.trim()}>{pending ? "正在保存…" : "保存设置"}</button>
    {dirty && <button type="button" className="secondary-button" disabled={pending} onClick={discard}>取消修改</button>}
    {feedback && <p role={feedback.failed ? "alert" : "status"}>{feedback.message}</p>}
  </form>;
}
