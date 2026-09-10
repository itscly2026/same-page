import { useLiveQuery } from "dexie-react-hooks";
import { readAnnotationLayers } from "../annotations/annotation-state";
import { useEffect, useState } from "react";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { scorePdfFileName } from "../../shared/score-display-name";
import { Dialog } from "../navigation/overlays";
import type { LocalWorkspace } from "../platform/local-workspace";
import type { PDFDocumentProxy } from "./pdf-document";
import { exportScore } from "./export-score";
import { prepareExport } from "./prepare-export";
import { FileUp } from "lucide-react";
import "./export-dialog.css";
import { holdUpdate } from "../updates/update-safety";

export function ExportDialog({ layers: initialLayers, workspace, source: initialSource, versionId, fileName, authenticatedUserId, onClose }: {
  layers?: AnnotationLayerSummary[]; workspace: LocalWorkspace; source?: PDFDocumentProxy; versionId: string; fileName: string;
  authenticatedUserId: string | null; onClose(): void;
}) {
  const [prepared, setPrepared] = useState<{ source: PDFDocumentProxy; layers: AnnotationLayerSummary[] } | null>(() => initialSource && initialLayers ? { source: initialSource, layers: initialLayers } : null);
  const liveLayers = useLiveQuery(() => readAnnotationLayers(workspace), [workspace.scopeKey]);
  const layers = initialLayers ?? liveLayers ?? prepared?.layers ?? [];
  const source = prepared?.source;
  const [selected, setSelected] = useState<string[]>(() => defaults(initialLayers ?? []));
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialSource && initialLayers) return;
    let active = true;
    const task = prepareExport(workspace, versionId);
    task.promise.then(result => { if (active) { setPrepared(result); setSelected(defaults(result.layers)); } }).catch(error => {
      if (active) setMessage(error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : "无法准备 PDF，请检查网络后重试。");
    });
    return () => { active = false; task.destroy(); };
  }, [workspace, versionId, initialSource, initialLayers, attempt]);
  const run = async () => {
    if (!source) return;
    const release = holdUpdate();
    setBusy(true); setMessage(null);
    try {
      const blob = await exportScore(workspace, source, versionId, includeNotes ? selected : [], authenticatedUserId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = scorePdfFileName(fileName); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      // The browser owns the download UI; keep choices available without a success notice.
    } catch (error) { setMessage(error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : "导出未完成，未生成不完整文件。请确认联网与笔记数据后重试。"); }
    finally { setBusy(false); release(); }
  };
  return <ModalOverlay className="modal-overlay" isOpen isDismissable={!busy} onOpenChange={open => { if (!open && !busy) onClose(); }}><Modal className="app-modal"><Dialog className="app-dialog export-dialog" exitDisabled={busy}>
    <Heading slot="title"><FileUp aria-hidden="true" size={22} />导出 PDF</Heading>
    <p className="export-file-name">{fileName}</p>
    {!prepared && !message && <p role="status">正在准备 PDF 和笔记…</p>}
    {prepared && <>
      <fieldset className="export-mode" disabled={busy}><legend>导出内容</legend>
        <label><input type="radio" name="export-content" checked={!includeNotes} onChange={() => setIncludeNotes(false)} />仅原谱</label>
        <label><input type="radio" name="export-content" checked={includeNotes} onChange={() => setIncludeNotes(true)} />包含笔记</label>
      </fieldset>
      {includeNotes && <div className="export-layers">
        <p className="export-help">选择要包含的笔记，不会改变阅读时的显示设置。</p>
        {([['共享层', layers.filter(layer => layer.kind === "shared")], ['我的个人层', layers.filter(layer => layer.kind === "personal" && layer.canEdit)], ['成员分享', layers.filter(layer => layer.kind === "personal" && !layer.canEdit)]] as const).map(([title, group]) => group.length > 0 && <fieldset key={title} disabled={busy}><legend>{title}</legend>
          {group.map(layer => <label className="export-layer" key={layer.id}><input type="checkbox" checked={selected.includes(layer.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, layer.id] : ids.filter(id => id !== layer.id))} /><span className="export-layer-color" style={{ background: layer.displayColor }} /><span>{layer.name}</span></label>)}
        </fieldset>)}
        {layers.length === 0 && <p>没有可导出的笔记层。</p>}
        <p className="export-help">{selected.length ? `已选 ${selected.length} 个笔记层` : "未选择笔记层，将导出原谱。"}</p>
      </div>}
    </>}
    {includeNotes && selected.some(id => !layers.some(layer => layer.id === id)) && <p role="alert">部分已选层不再可用。<Button isDisabled={busy} onPress={() => setSelected(ids => ids.filter(id => layers.some(layer => layer.id === id)))}>移除不可用层</Button></p>}
    {message && <p role="alert">{message}{!prepared && <Button className="text-button" onPress={() => { setMessage(null); setAttempt(value => value + 1); }}>重试</Button>}</p>}
    <div className="export-actions"><Button className="secondary-button" isDisabled={busy} onPress={onClose}>取消</Button><Button className="primary-button" isDisabled={busy || !prepared} onPress={() => void run()}>{busy ? "正在导出…" : "导出 PDF"}</Button></div>
  </Dialog></Modal></ModalOverlay>;
}

function defaults(layers: AnnotationLayerSummary[]) {
  return layers.filter(layer => layer.subscribed || (layer.kind === "personal" && layer.canEdit)).map(layer => layer.id);
}
