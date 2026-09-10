import { joinDrive, openDriveAdmission } from "../auth/drive-entry";
import type { DriveCapabilities } from "../../shared/drive-permissions";
import { type ChoirSummary } from "../../shared/choirs";
import { driveBootstrapResponseSchema, type ScoreListResponse } from "../../shared/scores";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";

export type DriveLibraryAccess =
  | { kind: "loading"; choir?: ChoirSummary }
  | { kind: "opened"; choir: ChoirSummary; result: ScoreListResponse; isMember: boolean; local?: boolean; retained?: boolean; rememberedMembership?: boolean; managementVisible?: boolean; rememberedCapabilities?: DriveCapabilities }
  | { kind: "join-required"; choir: ChoirSummary }
  | { kind: "denied"; admissionBlocked?: boolean }
  | { kind: "not-found" }
  | { kind: "failed"; authenticationRequired?: boolean };

type LoadedAccess = Exclude<DriveLibraryAccess, { kind: "loading" }>;

export interface DriveLibraryTransport {
  load(signal: AbortSignal, allowAdmission: boolean, authenticated: boolean): Promise<LoadedAccess>;
  join(displayName: string, signal: AbortSignal): Promise<string | null>;
}

export function driveLibraryTransport(choirId: string): DriveLibraryTransport {
  const bootstrap = async (signal: AbortSignal, authenticated: boolean): Promise<LoadedAccess> => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/bootstrap`, { signal });
    if (response.status === 401 && authenticated) return { kind: "failed", authenticationRequired: true };
    if ([401, 403].includes(response.status)) {
      const body = await response.json().catch(() => null);
      if (authenticated && body?.error === "authentication_required") return { kind: "failed", authenticationRequired: true };
      return { kind: "denied", ...(body?.error === "membership_requires_admin" ? { admissionBlocked: true } : {}) };
    }
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "failed" };
    const payload = await parseDiagnosticResponse(response, driveBootstrapResponseSchema);
    signal.throwIfAborted();
    return {
      kind: "opened", choir: payload.choir, isMember: payload.permissions.access === "membership",
      result: { scores: payload.scores, storage: payload.storage, permissions: { capabilities: payload.permissions.capabilities } },
    };
  };
  return {
    async load(signal, allowAdmission, authenticated) {
      const first = await bootstrap(signal, authenticated);
      if (!allowAdmission || (first.kind === "denied" && first.admissionBlocked) || !["denied", "not-found"].includes(first.kind)) return first;
      const admission = await openDriveAdmission(choirId, authenticated, signal);
      if (admission.kind === "none") return first;
      if (admission.kind === "failed") return { kind: "failed" };
      if (admission.kind === "display-name") return { kind: "join-required", choir: admission.choir };
      return bootstrap(signal, authenticated);
    },
    async join(displayName, signal) {
      const result = await joinDrive({ kind: "open", choirId }, displayName, signal);
      return result.kind === "failed" ? result.message : null;
    },
  };
}
