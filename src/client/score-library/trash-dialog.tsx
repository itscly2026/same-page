import { diagnosticFetch } from "../diagnostics/diagnostics";
import { type FormEvent, useEffect, useState } from "react";
import {
  Button,

  Form,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import { Dialog } from "../navigation/overlays";

import {
  scoreTrashResponseSchema,
  type TrashedScoreSummary,
} from "../../shared/scores";
import { LibraryDialogHeading } from "./library-dialog-heading";
import { uploadMessage } from "./library-format";

export function TrashDialog({
  choirId,
  onClose,
  onRestored,
}: {
  choirId: string;
  onClose: () => void;
  onRestored: () => void | Promise<void>;
}) {
  const [trash, setTrash] = useState<TrashedScoreSummary[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreConflict, setRestoreConflict] = useState<TrashedScoreSummary | null>(null);
  const [restoreName, setRestoreName] = useState("");

  useEffect(() => {
    let active = true;
    void diagnosticFetch(`/api/choirs/${choirId}/scores/trash`)
      .then(async (response) => {
        if (!response.ok) throw new Error("trash_unavailable");
        const scores = scoreTrashResponseSchema.parse(await response.json()).scores;
        if (active) setTrash(scores);
      })
      .catch(() => {
        if (active) setMessage("暂时无法打开回收站。");
      });
    return () => {
      active = false;
    };
  }, [choirId]);

  const restoreScore = async (score: TrashedScoreSummary, nextName?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      if (nextName) {
        const rename = await diagnosticFetch(`/api/choirs/${choirId}/scores/${score.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileName: nextName }),
        });
        if (!rename.ok) {
          setMessage(uploadMessage(rename.status, await rename.json().catch(() => null)));
          return;
        }
      }
      const response = await diagnosticFetch(`/api/choirs/${choirId}/scores/${score.id}/restore`, {
        method: "POST",
      });
      if (response.status === 409) {
        setRestoreConflict(score);
        setRestoreName(score.fileName);
        setMessage("当前文件库已有同名文件，请先为恢复的文件换一个名称。");
        return;
      }
      if (response.status === 404) {
        setRestoreConflict(null);
        setTrash((current) => current.filter((entry) => entry.id !== score.id));
        setMessage("这份乐谱已不在可恢复的回收站中，可能已到期或被处理。请刷新云盘。");
        return;
      }
      if (!response.ok) throw new Error("restore_failed");
      setRestoreConflict(null);
      setTrash((current) => current.filter((entry) => entry.id !== score.id));
      setMessage("文件已恢复。批注和 PDF 版本保持不变。");
      await onRestored();
    } catch {
      setMessage("恢复未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const submitConflict = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (restoreConflict) void restoreScore(restoreConflict, restoreName);
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
      <Modal className="app-modal">
        <Dialog className="app-dialog">
          {({ close }) => (
            <>
              <LibraryDialogHeading title="回收站" close={close} />
              <p className="dialog-copy">
                文件保留三十天，到期自动删除。这里不提供手工永久删除。
              </p>
              {trash.length > 0 ? (
                <ul className="trash-list">
                  {trash.map((score) => (
                    <li key={score.id}>
                      <span>
                        <strong>{score.fileName}</strong>
                        <small>{daysRemaining(score.trashExpiresAt)} 天后自动删除</small>
                      </span>
                      <Button isDisabled={busy} onPress={() => void restoreScore(score)}>
                        恢复
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty-library">回收站是空的。</p>
              )}
              {restoreConflict ? (
                <Form className="entry-form restore-conflict" onSubmit={submitConflict}>
                  <TextField isRequired value={restoreName} onChange={setRestoreName} maxLength={255}>
                    <Label>恢复时使用的新文件名</Label>
                    <Input autoFocus />
                  </TextField>
                  <Button type="submit" isDisabled={busy}>
                    重命名并恢复
                  </Button>
                </Form>
              ) : null}
              {message ? (
                <p className="form-message" role="status">
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

function daysRemaining(expiresAt: number) {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}
