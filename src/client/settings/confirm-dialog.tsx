import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Dialog } from "../navigation/overlays";

export type Confirmation = { title: string; message: string; action: string; onConfirm: () => Promise<void> };

export function ConfirmDialog({ confirmation, busy, onClose }: { confirmation: Confirmation | null; busy: boolean; onClose: () => void }) {
  if (!confirmation) return null;
  return <ModalOverlay className="modal-overlay" isOpen isDismissable={!busy} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Modal className="app-modal app-modal--compact"><Dialog className="app-dialog" exitDisabled={busy}>
      <Heading slot="title">{confirmation.title}</Heading>
      <p className="dialog-copy">{confirmation.message}</p>
      <div className="settings-actions">
        <Button className="secondary-button" isDisabled={busy} onPress={onClose} autoFocus>取消</Button>
        <Button className="primary-button" isDisabled={busy} onPress={() => void confirmation.onConfirm().then(onClose)}>{busy ? "正在处理…" : confirmation.action}</Button>
      </div>
    </Dialog></Modal>
  </ModalOverlay>;
}
