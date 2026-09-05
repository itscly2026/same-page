import { diagnosticFetch } from "../diagnostics/diagnostics";
import { type FormEvent, lazy, Suspense, useState } from "react";
import {
  Button,
  Dialog,
  Form,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";

import type { ScoreSummary } from "../../shared/scores";
import { LibraryDialogHeading } from "./library-dialog-heading";
import { formatBytes, uploadMessage } from "./library-format";

const PdfVersionDialog = lazy(() => import("./pdf-version-dialog").then((module) => ({ default: module.PdfVersionDialog })));

export type ScoreAction = "info" | "rename" | "replace" | "history" | "trash";

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
  if (selection.action === "info") {
    const { score } = selection;
    return (
      <ModalOverlay className="modal-overlay" isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}>
        <Modal className="app-modal app-modal--compact">
          <Dialog className="app-dialog file-info-dialog">
            <Heading slot="title">文件信息</Heading>
            <p className="file-info-name">{score.fileName}</p>
            <dl className="file-info-list">
              <div><dt>文件大小</dt><dd>{formatBytes(score.currentVersion.sizeBytes)}</dd></div>
              <div><dt>页数</dt><dd>{score.currentVersion.pageCount}</dd></div>
              <div><dt>PDF 版本</dt><dd>{score.currentVersion.versionNumber}</dd></div>
            </dl>
            <Button className="secondary-button" onPress={onClose}>关闭</Button>
          </Dialog>
        </Modal>
      </ModalOverlay>
    );
  }
  if (selection.action === "replace" || selection.action === "history") {
    return <Suspense fallback={<p role="status">正在加载版本工具…</p>}><PdfVersionDialog choirId={choirId} score={selection.score} historyOnly={selection.action === "history"}
      onClose={onClose} onComplete={onComplete} /></Suspense>;
  }
  return <BasicScoreActionDialog choirId={choirId} selection={selection} onClose={onClose} onComplete={onComplete} />;
}

function BasicScoreActionDialog({ choirId, selection, onClose, onComplete }: Parameters<typeof ScoreActionDialog>[0]) {
  const [renameValue, setRenameValue] = useState(selection.score.fileName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await runScoreAction(choirId, selection, renameValue);
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
                ) : (
                  <p className="dialog-copy">
                    “{selection.score.fileName}”将从文件库消失，三十天内可从回收站恢复。
                  </p>
                )}
                <Button
                  type="submit"
                  isDisabled={busy}
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
) {
  const scorePath = `/api/choirs/${choirId}/scores/${selection.score.id}`;
  if (selection.action === "rename") {
    return diagnosticFetch(scorePath, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: renameValue }),
    });
  }
  return diagnosticFetch(scorePath, { method: "DELETE" });
}

function actionTitle(action: ScoreAction) {
  if (action === "rename") return "重命名";
  return "移到回收站";
}

function successMessage(action: ScoreAction) {
  if (action === "rename") return "文件已重命名。";
  return "文件已移到回收站，将在三十天后自动删除。";
}
