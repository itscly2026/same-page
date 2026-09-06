import { Button,  DialogTrigger, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import type { DiagnosticReader } from "../../shared/diagnostic-report";
import { DiagnosticReportForm } from "./diagnostic-report-form";

export function DiagnosticReportDialog({ reader }: { reader: DiagnosticReader }) {
  return <DialogTrigger>
    <Button className="secondary-button">故障诊断</Button>
    <DiagnosticReportModal reader={reader} />
  </DialogTrigger>;
}

export function DiagnosticReportModal({ reader, isOpen, onOpenChange }: {
  reader: DiagnosticReader;
  isOpen?: boolean;
  onOpenChange?(isOpen: boolean): void;
}) {
  return <ModalOverlay className="diagnostic-overlay" isDismissable isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal className="diagnostic-modal">
        <Dialog>
          {({ close }) => <>
            <div className="diagnostic-dialog-heading">
              <Heading slot="title">故障诊断</Heading>
              <Button className="secondary-button" onPress={close}>关闭</Button>
            </div>
            <DiagnosticReportForm reader={reader} />
          </>}
        </Dialog>
      </Modal>
    </ModalOverlay>;
}
