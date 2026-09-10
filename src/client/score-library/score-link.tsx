import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useOfflineScore } from "../offline/use-offline-score";
import { experienceOwnerKey, authenticatedLocalOwnerKey, createLocalWorkspace, currentLocalOwnerKey } from "../platform/local-workspace";

export function ScoreLink({ userId, choirId, scoreId, local, experience = false, label, description, children, onOpen }: {
  label: string; description: string; experience?: boolean; userId?: string; choirId: string; scoreId: string; local: boolean; children: ReactNode; onOpen: () => void;
}) {
  const guestOwner = useLiveQuery(async () => {
    if (userId || !local) return null;
    const owner = await currentLocalOwnerKey();
    return owner?.startsWith("guest:") ? owner : null;
  }, [userId, local]);
  const owner = userId ? authenticatedLocalOwnerKey(userId) : guestOwner;
  const workspace = useMemo(() => owner && local ? createLocalWorkspace(experience ? experienceOwnerKey(owner) : owner, choirId, scoreId) : null, [owner, choirId, scoreId, local, experience]);
  const offline = useOfflineScore(workspace);
  const ready = offline?.scopeKey === workspace?.scopeKey && offline?.record && !offline.invalid;
  return local && !ready
    ? <div className="file-row__open" aria-disabled="true">{children}<small>{offline === undefined ? "正在校验…" : "需联网打开"}</small></div>
    : <Link aria-label={label} aria-description={description} className="file-row__open" to={`/choirs/${choirId}/scores/${scoreId}${experience ? "?experience=1" : ""}`} onClick={onOpen}>{children}</Link>;
}
