import { useEffect, useState } from "react";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import type { ScoreSummary } from "../../shared/scores";
import { Dialog } from "../navigation/overlays";
import { resolveLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";
import { ExportDialog } from "../reader/export-dialog";

export function LibraryExportDialog({ score, authenticatedUserId, onClose }: {
  score: ScoreSummary; authenticatedUserId: string | null; onClose(): void;
}) {
  const [workspace, setWorkspace] = useState<LocalWorkspace | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void resolveLocalWorkspace({ authenticatedUserId, choirId: score.choirId, scoreId: score.id, signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setWorkspace(value); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [authenticatedUserId, score.choirId, score.id]);
  if (workspace) return <ExportDialog workspace={workspace} versionId={score.currentVersion.id} fileName={score.fileName} authenticatedUserId={authenticatedUserId} onClose={onClose} />;
  return <ModalOverlay className="modal-overlay" isOpen isDismissable onOpenChange={open => { if (!open) onClose(); }}><Modal className="app-modal"><Dialog className="app-dialog"><Heading slot="title">导出 PDF</Heading><p role={failed ? "alert" : "status"}>{failed ? "请确认登录身份后重新导出。" : "正在准备…"}</p><Button className="secondary-button" onPress={onClose}>取消</Button></Dialog></Modal></ModalOverlay>;
}
