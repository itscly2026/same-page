import { useState } from "react";
import { Button } from "react-aria-components";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { readScoreAnnotationState } from "../annotations/annotation-state";
import type { LocalWorkspace } from "../platform/local-workspace";

export function PersonalLayerCard({ layer, workspace, pending, onChange, onSubscribe }: {
  layer: AnnotationLayerSummary;
  workspace: LocalWorkspace;
  pending: boolean;
  onChange(change: { name?: string; sharing?: boolean; action?: "delete" | "restore" }): Promise<boolean | undefined>;
  onSubscribe(subscribed: boolean): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(layer.name);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    const state = await readScoreAnnotationState(workspace);
    if (state.annotations.some(note => note.layerId === layer.id && note.state !== "synced") || state.conflicts.some(note => note.layerId === layer.id)) {
      setError("此层有未同步内容或冲突，请先完成同步和冲突处理，再删除。");
      return;
    }
    if (await onChange({ action: "delete" })) setConfirming(false);
  };
  return <article className="layer-card">
    <div className="layer-card__main">
      <label className="reader-layer-toggle"><input type="checkbox" aria-label={`显示 ${layer.name}`} checked={layer.subscribed} disabled={pending}
        onChange={event => onSubscribe(event.target.checked)} /><strong>{layer.name}</strong></label>
      <Button className="personal-layer-more" aria-label={`管理 ${layer.name}`} aria-expanded={expanded} isDisabled={pending}
        onPress={() => setExpanded(!expanded)}>⋯</Button>
    </div>
    {layer.sharing && <p className="personal-layer-audience">云盘成员可见</p>}
    {expanded && <div className="personal-layer-actions" role="group" aria-label={`${layer.name}的操作`}>
      {layer.canShare && <Button aria-label={`分享 ${layer.name}`} aria-pressed={!!layer.sharing} isDisabled={pending}
        onPress={() => void onChange({ sharing: !layer.sharing })}>{layer.sharing ? "停止分享" : "分享给云盘成员"}</Button>}
      <Button isDisabled={pending} onPress={() => { setName(layer.name); setRenaming(!renaming); setConfirming(false); }}>重命名</Button>
      <Button className="personal-layer-delete" isDisabled={pending} onPress={() => { setConfirming(true); setRenaming(false); }}>删除</Button>
    </div>}
    {renaming && <form onSubmit={event => { event.preventDefault(); void onChange({ name: name.trim() }).then(saved => { if (saved) setRenaming(false); }); }}>
      <input aria-label={`${layer.name}的名称`} maxLength={60} required value={name} onChange={event => setName(event.target.value)} />
      <button disabled={pending || !name.trim()}>保存名称</button>
    </form>}
    {confirming && <div role="group" aria-label={`删除 ${layer.name}`}>
      <p>删除“{layer.name}”并停止分享？三十天内可恢复，恢复后不会自动分享。未同步内容必须先同步。</p>
      <Button isDisabled={pending} onPress={() => void remove().catch(() => setError("无法确认本机内容，请重试。"))}>确认删除</Button>
      <Button onPress={() => setConfirming(false)}>取消</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
