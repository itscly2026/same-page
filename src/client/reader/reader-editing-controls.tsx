import { sharedLayerLabel, sharedLayerDisplayName, sharedLayerPrefix } from "../../shared/annotations";
import { useState } from "react";
import { ChevronDown, Eraser, Lock, Pencil, Redo2, Type, Undo2, X } from "lucide-react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";

import {
  type AnnotationLayerSummary,
  type SharedLayerSlot,
} from "../../shared/annotations";
import type { AnnotationTool } from "../annotations/annotation-overlay";
import type { AnnotationEditor } from "../annotations/annotation-editor";
import "./reader-ux.css";

export function ReaderEditingControls({
  isDisabled,
  editor,
  layers,
  tool,
  activeLayerId,
  onToolChange,
  onLayerChange,
}: {
  isDisabled: boolean;
  editor: AnnotationEditor;
  layers: AnnotationLayerSummary[];
  tool: AnnotationTool;
  activeLayerId: string | null;
  onToolChange(tool: AnnotationTool): void;
  onLayerChange(layerId: string): void;
}) {
  const [choosingLayer, setChoosingLayer] = useState(false);
  const [showHint, setShowHint] = useState(() => {
    try { return localStorage.getItem("reader-edit-hint-seen") !== "true"; } catch { return true; }
  });
  const selectedLayer = layers.find((layer) => layer.id === activeLayerId);
  const chooseLayer = (layerId: string) => {
    onLayerChange(layerId);
    setChoosingLayer(false);
  };
  const personalLayer = layers.find((layer) => layer.kind === "personal" && layer.canEdit);

  return (
    <section className="annotation-controls" aria-label="批注工具">
      {showHint && <div className="reader-edit-first-hint" role="status">
        <span>编辑时仅显示当前层，并锁定本页。点勾号完成后恢复。</span>
        <Button aria-label="关闭编辑提示" onPress={() => { setShowHint(false); try { localStorage.setItem("reader-edit-hint-seen", "true"); } catch { /* Optional hint preference. */ } }}><X aria-hidden="true" size={18} /></Button>
      </div>}
      <DialogTrigger isOpen={choosingLayer} onOpenChange={setChoosingLayer}>
        <Button
          isDisabled={isDisabled}
          className="reader-edit-layer-trigger"
          aria-label={`当前编辑层：${selectedLayer?.kind === "personal" ? "P · 我的笔记" : sharedLayerLabel(selectedLayer?.sharedSlot, selectedLayer?.name ?? "")}，写到哪里`}
        >
          <span>{selectedLayer?.kind === "personal" ? "P ·" : sharedLayerPrefix(selectedLayer?.sharedSlot) ? `${sharedLayerPrefix(selectedLayer?.sharedSlot)} ·` : ""}</span>
          <span>{selectedLayer?.kind === "personal" ? "我的笔记" : sharedLayerDisplayName(selectedLayer?.sharedSlot, selectedLayer?.name ?? "")}</span>
          <ChevronDown aria-hidden="true" size={14} />
        </Button>
        <Popover className="reader-edit-layer-popover" placement="top" offset={12}>
          <Dialog aria-label="写到哪里">
            <div className="reader-target-heading"><h2>写到哪里</h2><Button aria-label="关闭写入目标" onPress={() => setChoosingLayer(false)}><X aria-hidden="true" size={18} /></Button></div>
            <p>共享层 · 此云盘可见</p>
            <div className="annotation-layer-switcher" aria-label="编辑层">
              {layers.filter(layer => layer.kind === "shared").map((layer) => (
                <LayerSlotButton
                  isDisabled={isDisabled}
                  key={layer.id}
                  slot={layer.sharedSlot!}
                  layer={layer}
                  activeLayerId={activeLayerId}
                  onLayerChange={chooseLayer}
                />
              ))}
            </div>
            <p>个人层 · {personalLayer?.sharing ? "云盘成员可见，只有你能编辑" : "仅自己可见"}</p>
            <div className="annotation-layer-switcher">
              <LayerSlotButton
                isDisabled={isDisabled}
                slot="P"
                layer={personalLayer}
                activeLayerId={activeLayerId}
                onLayerChange={chooseLayer}
              />
            </div>
            <p>编辑时只显示所选层，并锁定当前页。</p>
          </Dialog>
        </Popover>
      </DialogTrigger>
      <div className="annotation-control-group" aria-label="工具">
        <div className="segmented-control" aria-label="批注工具">
          {(["text", "ink", "eraser"] as const).map((entry) => (
            <Button
              isDisabled={isDisabled || !selectedLayer?.canEdit}
              aria-label={{ text: "文本", ink: "画笔", eraser: "整条橡皮" }[entry]}
              aria-pressed={tool === entry}
              className="annotation-tool-button"
              key={entry}
              onPress={() => onToolChange(entry)}
            >
              <AnnotationToolIcon tool={entry} />
            </Button>
          ))}
        </div>
      </div>
      <div className="annotation-control-group annotation-history-controls" aria-label="历史">
        <Button
          isDisabled={isDisabled || !selectedLayer?.canEdit}
          aria-label="撤销"
          className="annotation-tool-button"
          onPress={() => activeLayerId ? void editor.undo(activeLayerId) : undefined}
        >
          <Undo2 aria-hidden="true" size={20} />
        </Button>
        <Button
          isDisabled={isDisabled || !selectedLayer?.canEdit}
          aria-label="重做"
          className="annotation-tool-button"
          onPress={() => activeLayerId ? void editor.redo(activeLayerId) : undefined}
        >
          <Redo2 aria-hidden="true" size={20} />
        </Button>
      </div>
    </section>
  );
}

function LayerSlotButton({
  isDisabled,
  slot,
  layer,
  activeLayerId,
  onLayerChange,
}: {
  isDisabled: boolean;
  slot: SharedLayerSlot | "P";
  layer: AnnotationLayerSummary | undefined;
  activeLayerId: string | null;
  onLayerChange(layerId: string): void;
}) {
  const label = slot === "P" ? "P，我的笔记" : sharedLayerLabel(slot, layer?.name ?? "", "，");
  const button = (
    <Button
      isDisabled={isDisabled}
      aria-label={`${label}${layer?.canEdit ? "" : "，只读，查看权限说明"}`}
      aria-pressed={layer?.id === activeLayerId}
      className="annotation-layer-slot"
      onPress={() => {
        if (layer?.canEdit) onLayerChange(layer.id);
      }}
    >
      <i aria-hidden="true" style={{ background: layer?.displayColor ?? "transparent" }} />
      <span>{slot === "P" ? "P · 我的笔记" : sharedLayerLabel(slot, layer?.name ?? "")}</span>
      {layer && !layer.canEdit ? (
        <Lock aria-hidden="true" className="annotation-layer-slot__lock" size={11} />
      ) : null}
      {layer && !layer.canEdit ? <small>需管理员授权</small> : null}
    </Button>
  );
  if (!layer || layer.canEdit) return button;
  return (
    <DialogTrigger>
      {button}
      <Popover className="layer-permission-popover" offset={12} placement="top">
        <Dialog aria-label="仅可查看" className="layer-permission-dialog">
          {({ close }) => <LayerPermissionContent layer={layer} onClose={close} />}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function LayerPermissionContent({
  layer,
  onClose,
}: {
  layer: AnnotationLayerSummary;
  onClose(): void;
}) {
  return (
    <>
      <div className="layer-permission-dialog__icon">
        <Lock aria-hidden="true" size={20} />
      </div>
      <h2>仅可查看</h2>
      <p>{sharedLayerPrefix(layer.sharedSlot) ? `${layer.sharedSlot} · ` : ""}{sharedLayerDisplayName(layer.sharedSlot, layer.name)} 可以查看，但只有云盘管理员和被授权成员可以编辑。</p>
      <p>如需编辑权限，请联系云盘管理员。</p>
      <Button className="primary-button" onPress={onClose}>知道了</Button>
    </>
  );
}

function AnnotationToolIcon({ tool }: { tool: AnnotationTool }) {
  if (tool === "text") return <Type aria-hidden="true" size={20} strokeWidth={2} />;
  if (tool === "ink") return <Pencil aria-hidden="true" size={20} strokeWidth={2} />;
  return <Eraser aria-hidden="true" size={20} strokeWidth={2} />;
}
