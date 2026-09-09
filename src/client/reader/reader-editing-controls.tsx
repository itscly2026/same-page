import { useId, useRef, useState } from "react";
import { MousePointer2, SlidersHorizontal, ChevronDown, Eraser, Highlighter, Square, Circle, Lock, Pencil, Redo2, Type, Undo2, X } from "lucide-react";
import { Button,  DialogTrigger, Popover } from "react-aria-components";
import { Dialog } from "../navigation/overlays";

import {
  type AnnotationLayerSummary,
} from "../../shared/annotations";
import type { AnnotationTool } from "../annotations/annotation-overlay";
import type { AnnotationEditor } from "../annotations/annotation-editor";
import "./reader-ux.css";
import { StyleFields } from "../annotations/style-fields";
import { defaultToolStyle, type ToolStyle } from "../annotations/tool-style";

export function ReaderEditingControls({
  isDisabled,
  editor,
  layers,
  tool,
  toolColor,
  toolStyle = defaultToolStyle(tool),
  onStyleChange = () => undefined,
  onColorChange,
  activeLayerId,
  onToolChange,
  onLayerChange,
}: {
  isDisabled: boolean;
  editor: AnnotationEditor;
  layers: AnnotationLayerSummary[];
  tool: AnnotationTool;
  toolColor: string;
  toolStyle?: ToolStyle;
  onStyleChange?(style: ToolStyle): void;
  onColorChange(color: string): void;
  activeLayerId: string | null;
  onToolChange(tool: AnnotationTool): void;
  onLayerChange(layerId: string): void;
}) {
  const styleAnchor = useRef<Element | null>(null);
  const styleDialogId = useId();
  const [styleSource, setStyleSource] = useState<AnnotationTool | "settings" | null>(null);
  const openStyle = (source: AnnotationTool | "settings", anchor: Element) => {
    styleAnchor.current = anchor;
    setStyleSource(source);
  };
  const [choosingLayer, setChoosingLayer] = useState(false);
  const [showHint, setShowHint] = useState(() => {
    try { return localStorage.getItem("reader-edit-hint-seen") !== "true"; } catch { return true; }
  });
  const toolHasStyle = tool !== "eraser" && tool !== "select";
  const selectedLayer = layers.find((layer) => layer.id === activeLayerId);
  const chooseLayer = (layerId: string) => {
    onLayerChange(layerId);
    setStyleSource(null);
    setChoosingLayer(false);
  };
  const personalLayers = layers.filter((layer) => layer.kind === "personal" && layer.canEdit);

  return (
    <section className="annotation-controls" aria-label="笔记工具">
      {showHint && <div className="reader-edit-first-hint" role="status">
        <span>编辑时仅显示当前层，并锁定本页。点勾号完成后恢复。</span>
        <Button aria-label="关闭编辑提示" onPress={() => { setShowHint(false); try { localStorage.setItem("reader-edit-hint-seen", "true"); } catch { /* Optional hint preference. */ } }}><X aria-hidden="true" size={18} /></Button>
      </div>}
      <DialogTrigger isOpen={choosingLayer} onOpenChange={setChoosingLayer}>
        <Button
          isDisabled={isDisabled}
          className="reader-edit-layer-trigger"
          aria-label={`当前编辑层：${selectedLayer?.name ?? ""}，写到哪里`}
        >
          <span>{selectedLayer?.name}</span>
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
                  layer={layer}
                  activeLayerId={activeLayerId}
                  onLayerChange={chooseLayer}
                />
              ))}
            </div>
            <p>个人层 · 只有你能编辑</p>
            <div className="annotation-layer-switcher">
              {personalLayers.map(layer => <LayerSlotButton key={layer.id} isDisabled={isDisabled} layer={layer} activeLayerId={activeLayerId} onLayerChange={chooseLayer} />)}
            </div>
            <p>编辑时只显示所选层，并锁定当前页。</p>
          </Dialog>
        </Popover>
      </DialogTrigger>
      <div className="annotation-control-group annotation-drawing-tools" aria-label="工具">
        <div className="segmented-control" aria-label="笔记工具">
          {(["select", "ink", "highlighter", "eraser", "text", "rectangle", "ellipse"] as const).map((entry) => (
            <Button
              isDisabled={isDisabled || !selectedLayer?.canEdit}
              aria-label={{ select: "选择", text: "文字", ink: "画笔", highlighter: "荧光笔", rectangle: "矩形", ellipse: "椭圆", eraser: "整条橡皮" }[entry]}
              aria-pressed={tool === entry}
              aria-haspopup={entry === tool && toolHasStyle ? "dialog" : undefined}
              aria-expanded={entry === tool && toolHasStyle ? styleSource === entry : undefined}
              aria-controls={styleSource === entry ? styleDialogId : undefined}
              className={`annotation-tool-button${entry === "text" || entry === "rectangle" ? " annotation-tool-divider" : ""}`}
              key={entry}
              onPress={event => {
                if (entry === tool && toolHasStyle) openStyle(entry, event.target);
                else { setStyleSource(null); onToolChange(entry); }
              }}
            >
              <AnnotationToolIcon tool={entry} />
            </Button>
          ))}
        </div>
      </div>
      {selectedLayer?.kind === "personal" && <input type="color" aria-label="工具颜色" title={toolHasStyle ? "工具颜色" : "当前工具不使用颜色"} disabled={isDisabled || !selectedLayer.canEdit || !toolHasStyle} value={toolHasStyle ? toolColor : "#e5e7e5"} onChange={event => onColorChange(event.target.value)} />}
      <Button
        className="annotation-tool-button annotation-style-trigger"
        aria-label="下一笔样式"
        aria-haspopup="dialog"
        aria-expanded={styleSource === "settings"}
        aria-controls={styleSource === "settings" ? styleDialogId : undefined}
        isDisabled={isDisabled || !selectedLayer?.canEdit || !toolHasStyle}
        onPress={event => openStyle("settings", event.target)}
      ><SlidersHorizontal size={20} /></Button>
      <Popover
        className="annotation-style-popover"
        triggerRef={styleAnchor}
        isOpen={styleSource !== null && !isDisabled && !!selectedLayer?.canEdit && toolHasStyle}
        onOpenChange={open => { if (!open) setStyleSource(null); }}
        placement="top"
        offset={12}
      >
        <Dialog id={styleDialogId} aria-label="下一笔样式">
          <h2>{tool === "text" ? "新文字样式" : "下一笔样式"}</h2>
          <div style={{ color: selectedLayer?.kind === "shared" ? selectedLayer.displayColor : toolColor }}>
            <StyleFields tool={tool} value={toolStyle} onChange={onStyleChange} />
          </div>
        </Dialog>
      </Popover>
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
  layer,
  activeLayerId,
  onLayerChange,
}: {
  isDisabled: boolean;
  layer: AnnotationLayerSummary | undefined;
  activeLayerId: string | null;
  onLayerChange(layerId: string): void;
}) {
  const label = layer?.name ?? "";
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
      {layer?.kind === "shared" && <i aria-hidden="true" style={{ background: layer.displayColor }} />}
      <span>{layer?.name}</span>
      {layer && !layer.canEdit ? (
        <Lock aria-hidden="true" className="annotation-layer-slot__lock" size={11} />
      ) : null}
      {layer && !layer.canEdit ? <small>需获得此层编辑权</small> : null}
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
      <p>{layer.name} 可以查看，但只有云盘拥有者和获得此层编辑权的成员可以编辑。</p>
      <p>如需编辑权限，请联系云盘拥有者。</p>
      <Button className="primary-button" onPress={onClose}>知道了</Button>
    </>
  );
}

function AnnotationToolIcon({ tool }: { tool: AnnotationTool }) {
  if (tool === "select") return <MousePointer2 aria-hidden="true" size={20} />;
  if (tool === "text") return <Type aria-hidden="true" size={20} strokeWidth={2} />;
  if (tool === "ink") return <Pencil aria-hidden="true" size={20} strokeWidth={2} />;
  if (tool === "highlighter") return <Highlighter aria-hidden="true" size={20} />;
  if (tool === "rectangle") return <Square aria-hidden="true" size={20} />;
  if (tool === "ellipse") return <Circle aria-hidden="true" size={20} />;
  return <Eraser aria-hidden="true" size={20} strokeWidth={2} />;
}
