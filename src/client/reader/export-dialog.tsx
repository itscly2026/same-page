import { useState } from "react";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { scorePdfFileName } from "../../shared/score-display-name";
import { Dialog } from "../navigation/overlays";
import type { LocalWorkspace } from "../platform/local-workspace";
import type { ScoreDocument } from "./image-document";
import { ImageDocument } from "./image-document";
import { exportScore } from "./export-score";
import { holdUpdate } from "../updates/update-safety";

export function ExportDialog({ layers, workspace, source, versionId, fileName, authenticatedUserId, onClose }: {
  layers: AnnotationLayerSummary[]; workspace: LocalWorkspace; source: ScoreDocument; versionId: string; fileName: string;
  authenticatedUserId: string | null; onClose(): void;
}) {
  const [selected, setSelected] = useState(() => layers.filter(layer => layer.subscribed || (layer.kind === "personal" && layer.canEdit)).map(layer => layer.id));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const run = async () => {
    if (source instanceof ImageDocument) { setMessage("当前只有图片谱面，请切换到 PDF 并完整加载后导出，以保留原谱清晰度。"); return; }
    const release = holdUpdate();
    setBusy(true); setMessage(null);
    try {
      const blob = await exportScore(workspace, source, versionId, selected, authenticatedUserId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = scorePdfFileName(fileName); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage("PDF 已导出。");
    } catch (error) { setMessage(error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : "导出未完成，未生成不完整文件。请确认联网与批注数据后重试。"); }
    finally { setBusy(false); release(); }
  };
  return <ModalOverlay className="modal-overlay" isOpen isDismissable={!busy} onOpenChange={open => { if (!open && !busy) onClose(); }}><Modal className="app-modal"><Dialog className="app-dialog" exitDisabled={busy}>
    <Heading slot="title">导出 PDF</Heading><p>选择要包含的批注；本次选择不改变阅读订阅。取消全部可导出原谱。</p>
    {layers.map(layer => <label className="confirmation-checkbox" key={layer.id}><input type="checkbox" disabled={busy} checked={selected.includes(layer.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, layer.id] : ids.filter(id => id !== layer.id))} />{layer.kind === "personal" && layer.canEdit ? "我的笔记" : layer.name}</label>)}
    {message && <p role="status">{message}</p>}
    <Button className="secondary-button" isDisabled={busy} onPress={onClose}>关闭</Button><Button className="primary-button" isDisabled={busy} onPress={() => void run()}>{busy ? "正在导出…" : "导出 PDF"}</Button>
  </Dialog></Modal></ModalOverlay>;
}
