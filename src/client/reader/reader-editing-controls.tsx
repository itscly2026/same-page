import { Eraser, Lock, Pencil, Redo2, Type, Undo2 } from "lucide-react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";

import {
  defaultSharedLayerSlots,
  type AnnotationLayerSummary,
  type DefaultSharedLayerSlot,
} from "../../shared/annotations";
import type { AnnotationTool } from "../annotations/annotation-overlay";
import { redoAnnotationEdit, undoAnnotationEdit } from "../annotations/edit-history";
import type { LocalWorkspace } from "../platform/local-workspace";

export function ReaderEditingControls({
  workspace,
  layers,
  tool,
  activeLayerId,
  onToolChange,
  onLayerChange,
}: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  tool: AnnotationTool;
  activeLayerId: string | null;
  onToolChange(tool: AnnotationTool): void;
  onLayerChange(layerId: string): void;
}) {
  const defaultLayers = new Map(
    layers.filter((layer) => layer.defaultSlot !== null).map((layer) => [layer.defaultSlot, layer]),
  );
  const personalLayer = layers.find((layer) => layer.kind === "personal");

  return (
    <section className="annotation-controls" aria-label="批注工具">
      <div className="annotation-control-group" aria-label="编辑层">
        <div className="annotation-layer-switcher">
          {defaultSharedLayerSlots.map((slot) => (
            <LayerSlotButton
              key={slot}
              slot={slot}
              layer={defaultLayers.get(slot)}
              activeLayerId={activeLayerId}
              onLayerChange={onLayerChange}
            />
          ))}
          <LayerSlotButton
            slot="P"
            layer={personalLayer}
            activeLayerId={activeLayerId}
            onLayerChange={onLayerChange}
          />
        </div>
      </div>
      <div className="annotation-control-group" aria-label="工具">
        <div className="segmented-control" aria-label="批注工具">
          {(["text", "ink", "eraser"] as const).map((entry) => (
            <Button
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
          aria-label="撤销"
          className="annotation-tool-button"
          onPress={() => activeLayerId ? void undoAnnotationEdit(workspace, activeLayerId) : undefined}
        >
          <Undo2 aria-hidden="true" size={20} />
        </Button>
        <Button
          aria-label="重做"
          className="annotation-tool-button"
          onPress={() => activeLayerId ? void redoAnnotationEdit(workspace, activeLayerId) : undefined}
        >
          <Redo2 aria-hidden="true" size={20} />
        </Button>
      </div>
    </section>
  );
}

function LayerSlotButton({
  slot,
  layer,
  activeLayerId,
  onLayerChange,
}: {
  slot: DefaultSharedLayerSlot | "P";
  layer: AnnotationLayerSummary | undefined;
  activeLayerId: string | null;
  onLayerChange(layerId: string): void;
}) {
  const label = slot === "P" ? "P，Personal" : `${slot}，${layer?.name ?? slot}`;
  const button = (
    <Button
      aria-label={`${label}${layer?.canEdit ? "" : "，只读，查看权限说明"}`}
      aria-pressed={layer?.id === activeLayerId}
      className="annotation-layer-slot"
      onPress={() => {
        if (layer?.canEdit) onLayerChange(layer.id);
      }}
    >
      <span>{slot}</span>
      <i aria-hidden="true" style={{ background: layer?.displayColor ?? "transparent" }} />
      {layer && !layer.canEdit ? (
        <Lock aria-hidden="true" className="annotation-layer-slot__lock" size={11} />
      ) : null}
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
      <p>{layer.defaultSlot} · {layer.name} 可以查看，但只有云盘管理员和被授权成员可以编辑。</p>
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
