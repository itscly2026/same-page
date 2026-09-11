import { useRef } from "react";
import { scorePdfFileName } from "../../shared/score-display-name";
import type { ScoreSummary } from "../../shared/scores";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useSettingsMutation } from "../settings/settings-mutation";
import { type ConfirmedScoreChange, type DriveLibrary } from "./drive-library";
import { uploadMessage } from "./library-format";

// Mount inside the user/session/drive/selection-keyed dialog. Completion owns
// confirmed intent until both local projection and a fresh directory read settle.
export function useScoreFileAction(library: DriveLibrary, score: ScoreSummary, action: "rename" | "trash", onComplete: (message: string) => void) {
  const confirmed = useRef<ConfirmedScoreChange | undefined>(undefined);
  const mutation = useSettingsMutation({
    refresh: async isCurrent => {
      await library.completeScoreChange(confirmed.current);
      if (isCurrent()) confirmed.current = undefined;
    },
  });
  const complete = () => onComplete(action === "rename" ? "文件已重命名。" : "文件已移到回收站，将在三十天后自动删除。");

  const submit = async (name: string) => {
    const change: ConfirmedScoreChange = action === "rename"
      ? { kind: "rename", scoreId: score.id, fileName: scorePdfFileName(name) }
      : { kind: "trash", scoreId: score.id };
    const saved = await mutation.submit(
      () => diagnosticFetch(`/api/choirs/${score.choirId}/scores/${score.id}`, change.kind === "rename"
        ? { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName: change.fileName }) }
        : { method: "DELETE" }),
      { confirmed: () => { confirmed.current = change; }, rejectionMessage: (status, body) => status === 401 ? "登录已失效，请重新登录后再试。" : status === 403 ? "没有操作这份乐谱的权限，请联系云盘拥有者。" : uploadMessage(status, body) },
    );
    if (saved) complete();
  };

  const retry = async () => {
    const saved = confirmed.current;
    try {
      const reread = await mutation.refresh();
      // A successful recovery closes a confirmed action. An uncertain request
      // merely becomes editable again after the user has reread the directory.
      if (reread && saved) complete();
    } catch {
      // The submission module retains the original diagnosis and recovery gate.
    }
  };

  return { pending: mutation.pending, blocked: mutation.blocked, needsRefresh: mutation.needsRefresh, message: mutation.message, submit, retry };
}
