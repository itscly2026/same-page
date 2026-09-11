import { useRef } from "react";
import { scorePdfFileName } from "../../shared/score-display-name";
import type { ScoreSummary } from "../../shared/scores";
import { useSettingsMutation } from "../settings/settings-mutation";
import type { DriveLibrary } from "./drive-library";
import type { ScoreFileChange } from "./drive-library-transport";
import { uploadMessage } from "./library-format";

// Mount inside the user/session/drive/selection-keyed dialog. Write
// confirmation lives in the library so closing a dialog cannot bypass recovery.
export function useScoreFileAction(library: DriveLibrary, score: ScoreSummary, action: "rename" | "trash", onComplete: (message: string) => void) {
  const completed = useRef<ScoreFileChange | undefined>(undefined);
  const mutation = useSettingsMutation({
    initialRecovery: library.scoreChangeRecovery(score.id),
    refresh: async isCurrent => {
      const saved = await library.completeScoreChange(score.id);
      if (isCurrent()) completed.current = saved;
    },
  });
  const complete = (completedAction = action) => onComplete(completedAction === "rename" ? "文件已重命名。" : "文件已移到回收站，将在三十天后自动删除。");

  const submit = async (name: string) => {
    const change: ScoreFileChange = action === "rename"
      ? { kind: "rename", scoreId: score.id, fileName: scorePdfFileName(name) }
      : { kind: "trash", scoreId: score.id };
    const saved = await mutation.submit(
      () => library.requestScoreChange(change),
      { rejectionMessage: (status, body) => status === 401 ? "登录已失效，请重新登录后再试。" : status === 403 ? "没有操作这份乐谱的权限，请联系云盘拥有者。" : uploadMessage(status, body) },
    );
    if (saved) complete();
  };

  const retry = async () => {
    try {
      const reread = await mutation.refresh();
      // A successful recovery closes a confirmed action. An uncertain request
      // merely becomes editable again after the user has reread the directory.
      if (reread && completed.current) complete(completed.current.kind);
    } catch {
      // The submission module retains the original diagnosis and recovery gate.
    }
  };

  return { pending: mutation.pending, blocked: mutation.blocked, needsRefresh: mutation.needsRefresh, message: mutation.message, submit, retry };
}
