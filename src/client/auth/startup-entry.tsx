import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { choirMembershipsResponseSchema } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { driveCacheOwnerKey, rememberDriveSummary } from "../score-library/drive-library-cache";
import { readLastDrive } from "../score-library/last-drive";
import { readLocalDriveDirectories } from "../score-library/local-drive-directory";
import type { ApplicationIdentity } from "./application-identity";

type EntryResult = { path: string; missingLastDrive?: boolean } | "home" | "failed";

function destination(userId: string, driveIds: string[]): EntryResult {
  const lastDrive = readLastDrive(userId);
  if (lastDrive && !driveIds.includes(lastDrive)) return { path: "/drives", missingLastDrive: true };
  const driveId = lastDrive ?? (driveIds.length === 1 ? driveIds[0] : null);
  return driveId ? { path: `/choirs/${driveId}` } : driveIds.length ? { path: "/drives" } : "home";
}

// This component only exists for a startup intent. Explicit home visits never
// mount it, so a late session/directory response cannot redirect those visits.
export function StartupEntry({ identity }: { identity: ApplicationIdentity }) {
  const userId = identity.authenticatedUserId ?? identity.localUserId;
  const online = identity.onlineState === "authenticated";
  const [result, setResult] = useState<{ userId: string; online: boolean; value: EntryResult } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!userId) return;
    const ownerId = userId;
    const controller = new AbortController();
    async function resolve() {
      let value: EntryResult;
      if (online) {
        try {
          const response = await diagnosticFetch("/api/choirs", { signal: controller.signal });
          if (!response.ok) throw new Error("memberships_failed");
          const { memberships } = await parseDiagnosticResponse(response, choirMembershipsResponseSchema);
          if (controller.signal.aborted) return;
          const drives = memberships.filter(({ choir }) => !choir.isPreviewEntry);
          drives.forEach(({ choir }) => rememberDriveSummary(driveCacheOwnerKey(ownerId, choir.id), choir));
          value = destination(ownerId, drives.map(({ choir }) => choir.id));
        } catch {
          if (controller.signal.aborted) return;
          value = await localDestination(ownerId, true);
        }
      } else value = await localDestination(ownerId, false);
      if (!controller.signal.aborted) setResult({ userId: ownerId, online, value });
    }
    void resolve();
    return () => controller.abort();
  }, [userId, online, retry]);

  if (!result || result.userId !== userId || result.online !== online) return null;
  if (typeof result.value === "object") return <Navigate to={result.value.path} replace state={{ missingLastDrive: result.value.missingLastDrive }} />;
  if (result.value === "failed") return <p className="page-shell" role="status">暂时无法加载已加入的云盘。<button className="text-button" onClick={() => { setResult(null); setRetry(value => value + 1); }}>重试</button></p>;
  return null;
}

async function localDestination(userId: string, failedOnline: boolean): Promise<EntryResult> {
  try {
    const drives = (await readLocalDriveDirectories(userId)).filter(entry => entry.membership && !entry.choir.isPreviewEntry);
    // No saved membership means there is no local startup to restore. Keep the
    // public homepage available even when the network or local database fails.
    return drives.length ? destination(userId, drives.map(entry => entry.choirId)) : failedOnline ? "failed" : "home";
  } catch { return failedOnline ? "failed" : "home"; }
}
