import { useEffect } from "react";
import { localDatabase } from "../platform/local-database";
import { captureLocalWorkspaceSession, createLocalWorkspace, type LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import { flushReadingPreferences } from "./reading-preferences";

// Mounted only after the application's confirmed identity activates its local
// workspace. Recovery is independent of annotation uploads and reader navigation.
export function ReadingPreferenceRecovery({ ownerKey }: { ownerKey: LocalWorkspaceOwnerKey }) {
  useEffect(() => {
    const controller = new AbortController();
    const retry = async () => {
      if (!navigator.onLine || controller.signal.aborted) return;
      const rows = await localDatabase.readingPreferences.where("ownerKey").equals(ownerKey).filter(row => row.pending).toArray();
      const scopes = new Map(rows.map(row => [JSON.stringify([row.choirId, row.scoreId]), row]));
      await Promise.allSettled([...scopes.values()].map(async row => {
        controller.signal.throwIfAborted();
        const workspace = await captureLocalWorkspaceSession(createLocalWorkspace(ownerKey, row.choirId, row.scoreId));
        await flushReadingPreferences(workspace, undefined, controller.signal);
      }));
    };
    const recover = () => { void retry().catch(() => undefined); };
    recover(); window.addEventListener("online", recover);
    return () => { controller.abort(); window.removeEventListener("online", recover); };
  }, [ownerKey]);
  return null;
}
