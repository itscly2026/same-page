import { isLocalExperience } from "../annotations/guest-notes";
import { useId, useRef, useState, type ReactNode } from "react";
import { Button, Heading, Modal, ModalOverlay, Switch } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { readScoreAnnotationState } from "../annotations/annotation-state";
import type { LocalWorkspace } from "../platform/local-workspace";

export function PersonalLayerCard({ layer, editing, workspace, pending, blocked, feedback, onChange, onSubscribe }: {
  layer: AnnotationLayerSummary;
  editing: boolean;
  workspace: LocalWorkspace;
  pending: boolean;
  blocked: boolean;
  feedback: ReactNode;
  onChange(change: { name?: string; sharing?: boolean; action?: "delete" | "restore" }): Promise<boolean | undefined>;
  onSubscribe(subscribed: boolean): void;
}) {
  const visibilityId = useId();
  const [name, setName] = useState(layer.name);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const renameButton = useRef<HTMLButtonElement>(null);
  const closeRename = () => { setRenaming(false); requestAnimationFrame(() => renameButton.current?.focus()); };
  const remove = async () => {
    setChecking(true); setError("");
    try {
      const state = await readScoreAnnotationState(workspace);
      if (state.annotations.some(note => note.layerId === layer.id && note.state !== "synced") || state.conflicts.some(note => note.layerId === layer.id)) {
        setError("此层有未同步内容或冲突，请先完成同步和冲突处理，再删除。");
        return;
      }
      if (await onChange({ action: "delete" })) setConfirming(false);
    } catch { setError("无法确认本机内容，请重试。"); }
    finally { setChecking(false); }
  };
  return <article className="layer-card">
    <div className="layer-card__main reader-layer-row">
      <label className="layer-row__name" htmlFor={editing ? undefined : visibilityId}><strong>{layer.name}</strong></label>
      {editing ? <>
        <Button ref={renameButton} className="personal-layer-row-action" aria-label={`重命名 ${layer.name}`} isDisabled={pending || blocked || renaming} onPress={() => { setName(layer.name); setRenaming(true); }}>重命名</Button>
        <Button className="personal-layer-row-action personal-layer-row-action--delete" aria-label={`删除 ${layer.name}`} isDisabled={pending || blocked} onPress={() => { setError(""); setConfirming(true); }}>删除</Button>
      </> : <>
      {!isLocalExperience(workspace) && <Switch className="personal-layer-share layer-row__accessory" aria-label={`分享 ${layer.name}`} aria-description="开启后云盘成员可见，关闭后仅自己可见；仅作者可编辑" isSelected={!!layer.sharing} isDisabled={pending || blocked || !layer.canShare}
        onChange={sharing => void onChange({ sharing })}><span className="personal-layer-share-track" aria-hidden="true" /><span>分享</span></Switch>}
      <label className="layer-row__visibility"><input id={visibilityId} type="checkbox" aria-label={`显示 ${layer.name}`} checked={layer.subscribed}
        onChange={event => onSubscribe(event.target.checked)} /></label></>}
    </div>
    <div className="personal-layer-details"><p className="personal-layer-audience">{isLocalExperience(workspace) ? "仅保存在此浏览器" : layer.sharing ? "云盘成员可见" : "仅自己可见"}</p>
    </div>
    {renaming && <form className="personal-layer-rename" onSubmit={event => { event.preventDefault(); void onChange({ name: name.trim() }).then(saved => { if (saved) closeRename(); }); }}>
      <input autoFocus aria-label={`${layer.name}的名称`} maxLength={60} required value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && !pending) { event.stopPropagation(); closeRename(); } }} />
      <button disabled={pending || blocked || !name.trim()}>保存名称</button><Button isDisabled={pending} onPress={closeRename}>取消</Button>
    </form>}
    {!confirming && feedback}
    {confirming && <ModalOverlay className="modal-overlay" isOpen isDismissable={!pending && !checking} onOpenChange={open => { if (!open && !pending && !checking) setConfirming(false); }}>
      <Modal className="app-modal app-modal--compact"><Dialog className="app-dialog" exitDisabled={pending || checking}>
        <Heading slot="title">确认删除此层</Heading>
        <p>删除“{layer.name}”并停止分享？三十天内可恢复，恢复后不会自动分享。</p>
        {error && <p role="alert">{error}</p>}{feedback}
        <div className="settings-actions"><Button className="secondary-button" autoFocus isDisabled={pending || checking} onPress={() => setConfirming(false)}>取消</Button>
          <Button className="primary-button destructive-button" isDisabled={pending || checking || blocked} onPress={() => void remove()}>确认删除</Button></div>
      </Dialog></Modal>
    </ModalOverlay>}
  </article>;
}
