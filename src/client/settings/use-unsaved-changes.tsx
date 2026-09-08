import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useExitLayer } from "../navigation/navigation-context";

// A manual form never submits merely because navigation was requested.
export function useUnsavedChanges({ dirty, save, discard, subject = "修改" }: {
  dirty: boolean; subject?: string; save(): Promise<boolean>; discard(): void;
}) {
  const resolve = useRef<((result: boolean | "cancelled") => void) | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => () => { resolve.current?.("cancelled"); }, []);
  useExitLayer(dirty, "form", () => new Promise<boolean | "cancelled">(done => {
    resolve.current = done; setFailed(false); setOpen(true);
  }));
  const finish = (result: boolean | "cancelled") => {
    setOpen(false); resolve.current?.(result); resolve.current = null;
  };
  return <ModalOverlay className="modal-overlay" isOpen={open} isDismissable={!saving} onOpenChange={value => { if (!value && !saving) finish("cancelled"); }}>
    <Modal className="app-modal app-modal--compact"><Dialog className="app-dialog" aria-label="处理未保存的修改">
      <Heading slot="title">有未保存的修改</Heading><p>{subject}尚未保存。要保存后离开吗？</p>
      {failed && <p role="alert">保存尚未确认，请核对后重试；修改仍保留。</p>}
      <div className="unsaved-actions">
        <Button className="primary-button" isDisabled={saving} onPress={async () => {
          setSaving(true);
          try { if (await save()) finish(true); else setFailed(true); }
          catch { setFailed(true); }
          finally { setSaving(false); }
        }}>{saving ? "正在保存…" : "保存并返回"}</Button>
        <Button className="secondary-button" autoFocus isDisabled={saving} onPress={() => finish("cancelled")}>继续编辑</Button>
        <Button className="unsaved-discard" isDisabled={saving} onPress={() => { discard(); finish(true); }}>放弃修改</Button>
      </div>
    </Dialog></Modal>
  </ModalOverlay>;
}
