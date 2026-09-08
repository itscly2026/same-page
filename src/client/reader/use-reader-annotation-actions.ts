import { useEffect, useMemo } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { ReaderAnnotationActions } from "./reader-annotation-actions";

export function useReaderAnnotationActions(workspace: LocalWorkspace | null, authenticatedUserId: string | null, sessionId: string | null, online: boolean, trashed: boolean, confirmIdentity: () => Promise<unknown>) {
  const actions = useMemo(() => workspace ? new ReaderAnnotationActions(workspace, { authenticated: Boolean(authenticatedUserId && sessionId), online, trashed, confirmIdentity }) : null,
    [workspace, authenticatedUserId, sessionId, online, trashed, confirmIdentity]);
  useEffect(() => { actions?.start(); return () => actions?.stop(); }, [actions]);
  return actions;
}
