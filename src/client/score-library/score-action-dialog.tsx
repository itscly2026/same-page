import { type FormEvent, useState } from "react";
import {
  Button,
  Dialog,
  Form,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";

import type { ScoreSummary } from "../../shared/scores";
import { LibraryDialogHeading } from "./library-dialog-heading";
import { uploadMessage } from "./library-format";

export type ScoreAction = "rename" | "replace" | "trash";

export interface ScoreActionSelection {
  action: ScoreAction;
  score: ScoreSummary;
}

export function ScoreActionDialog({
  choirId,
  selection,
  onClose,
  onComplete,
}: {
  choirId: string;
  selection: ScoreActionSelection;
  onClose: () => void;
  onComplete: (message: string) => void | Promise<void>;
}) {
  const [renameValue, setRenameValue] = useState(selection.score.fileName);
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await runScoreAction(choirId, selection, renameValue, replacementFile);
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(uploadMessage(response.status, payload));
        return;
      }
      await onComplete(successMessage(selection.action));
    } catch {
      setMessage("操作未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isDismissable={!busy}
    >
      <Modal className="app-modal app-modal--compact">
        <Dialog className="app-dialog">
          {({ close }) => (
            <>
              <LibraryDialogHeading title={actionTitle(selection.action)} close={close} />
              <Form className="entry-form dialog-form" onSubmit={submit}>
                {selection.action === "rename" ? (
                  <TextField isRequired value={renameValue} onChange={setRenameValue} maxLength={255}>
                    <Label>文件名</Label>
                    <Input autoFocus />
                  </TextField>
                ) : selection.action === "replace" ? (
                  <label>
                    新的 PDF
                    <input
                      required
                      type="file"
                      accept="application/pdf,.pdf"
                      onChange={(event) =>
                        setReplacementFile(event.currentTarget.files?.[0] ?? null)
                      }
                    />
                  </label>
                ) : (
                  <p className="dialog-copy">
                    “{selection.score.fileName}”将从文件库消失，三十天内可从回收站恢复。
                  </p>
                )}
                <Button
                  type="submit"
                  isDisabled={busy || (selection.action === "replace" && !replacementFile)}
                >
                  {busy ? "正在处理…" : selection.action === "trash" ? "移到回收站" : "确认"}
                </Button>
              </Form>
              {message ? (
                <p className="form-message" role="alert">
                  {message}
                </p>
              ) : null}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function runScoreAction(
  choirId: string,
  selection: ScoreActionSelection,
  renameValue: string,
  replacementFile: File | null,
) {
  const scorePath = `/api/choirs/${choirId}/scores/${selection.score.id}`;
  if (selection.action === "rename") {
    return fetch(scorePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: renameValue }),
    });
  }
  if (selection.action === "replace") {
    if (!replacementFile) throw new Error("replacement_file_required");
    const form = new FormData();
    form.set("file", replacementFile);
    return fetch(`${scorePath}/versions`, { method: "POST", body: form });
  }
  return fetch(scorePath, { method: "DELETE" });
}

function actionTitle(action: ScoreAction) {
  if (action === "rename") return "重命名";
  if (action === "replace") return "替换 PDF";
  return "移到回收站";
}

function successMessage(action: ScoreAction) {
  if (action === "rename") return "文件已重命名。";
  if (action === "replace") return "PDF 已替换；现有批注继续使用原页码和坐标。";
  return "文件已移到回收站，将在三十天后自动删除。";
}
