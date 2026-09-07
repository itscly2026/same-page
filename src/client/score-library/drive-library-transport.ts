import type { DriveCapabilities } from "../../shared/drive-permissions";
import { guestSessionResponseSchema, type ChoirSummary } from "../../shared/choirs";
import { driveBootstrapResponseSchema, type ScoreListResponse } from "../../shared/scores";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";

export type DriveLibraryAccess =
  | { kind: "loading"; choir?: ChoirSummary }
  | { kind: "opened"; choir: ChoirSummary; result: ScoreListResponse; isMember: boolean; local?: boolean; rememberedMembership?: boolean; managementVisible?: boolean; rememberedCapabilities?: DriveCapabilities }
  | { kind: "join-required"; choir: ChoirSummary }
  | { kind: "denied" }
  | { kind: "not-found" }
  | { kind: "failed" };

type LoadedAccess = Exclude<DriveLibraryAccess, { kind: "loading" }>;

export interface DriveLibraryTransport {
  load(signal: AbortSignal, allowAdmission: boolean, authenticated: boolean): Promise<LoadedAccess>;
  join(displayName: string, signal: AbortSignal): Promise<string | null>;
}

export function driveLibraryTransport(choirId: string): DriveLibraryTransport {
  const bootstrap = async (signal: AbortSignal, authenticated: boolean): Promise<LoadedAccess> => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/bootstrap`, { signal });
    if ([401, 403].includes(response.status)) return { kind: "denied" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "failed" };
    const payload = await parseDiagnosticResponse(response, driveBootstrapResponseSchema);
    signal.throwIfAborted();
    if (authenticated && payload.permissions.access !== "guest") {
      void diagnosticFetch("/api/guest/session", { method: "DELETE", signal }).catch(() => null);
    }
    return {
      kind: "opened", choir: payload.choir, isMember: payload.permissions.access === "membership",
      result: { scores: payload.scores, storage: payload.storage, permissions: { capabilities: payload.permissions.capabilities } },
    };
  };
  return {
    async load(signal, allowAdmission, authenticated) {
      const first = await bootstrap(signal, authenticated);
      if (!allowAdmission || !["denied", "not-found"].includes(first.kind)) return first;
      const response = await diagnosticFetch(`/api/guest/choirs/${choirId}`, { signal });
      if (response.status === 404) return first;
      if (!response.ok) return { kind: "failed" };
      const admission = await parseDiagnosticResponse(response, guestSessionResponseSchema);
      signal.throwIfAborted();
      if (authenticated && admission.entryKind !== "preview") {
        return { kind: "join-required", choir: admission.choir };
      }
      const granted = await diagnosticFetch("/api/guest/session", {
        method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ admission: "open", choirId }),
      });
      if ([401, 403].includes(granted.status)) return { kind: "denied" };
      if (!granted.ok) return { kind: "failed" };
      signal.throwIfAborted();
      return bootstrap(signal, authenticated);
    },
    async join(displayName, signal) {
      const response = await diagnosticFetch("/api/choirs/join", {
        method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ admission: "open", choirId, displayName }),
      });
      return response.ok ? null : response.status === 403
        ? "该成员关系需要有成员恢复权限的人恢复。"
        : "暂时无法加入这个云盘，请稍后再试。";
    },
  };
}
