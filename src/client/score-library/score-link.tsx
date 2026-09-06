import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useOfflineScore } from "../offline/use-offline-score";
import { authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";

export function ScoreLink({ userId, choirId, scoreId, local, children, onOpen }: {
  userId?: string; choirId: string; scoreId: string; local: boolean; children: ReactNode; onOpen: () => void;
}) {
  const workspace = useMemo(() => userId && local ? createLocalWorkspace(authenticatedLocalOwnerKey(userId), choirId, scoreId) : null, [userId, choirId, scoreId, local]);
  const offline = useOfflineScore(workspace);
  const ready = offline?.scopeKey === workspace?.scopeKey && offline?.record && !offline.invalid;
  return local && !ready
    ? <div className="file-row__open" aria-disabled="true">{children}<small>{offline === undefined ? "正在校验…" : "需联网下载"}</small></div>
    : <Link className="file-row__open" to={`/choirs/${choirId}/scores/${scoreId}`} onClick={onOpen}>{children}</Link>;
}
