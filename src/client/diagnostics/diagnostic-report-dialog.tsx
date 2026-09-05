import { Button, Dialog, DialogTrigger, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { DiagnosticReader } from "../../shared/diagnostic-report";
import { DiagnosticReportForm } from "./diagnostic-report-form";

export function DiagnosticReportDialog({ reader }: { reader: DiagnosticReader }) {
  return <DialogTrigger>
    <Button className="secondary-button">故障诊断</Button>
    <ModalOverlay className="diagnostic-overlay" isDismissable>
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
    </ModalOverlay>
  </DialogTrigger>;
}
