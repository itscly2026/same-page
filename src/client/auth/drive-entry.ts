import { trialMessage } from "../drives/trial-messages";
import { guestJoinStateResponseSchema, guestSessionResponseSchema, type ChoirSummary, type GuestAdmissionRequest, type GuestSessionResponse } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { clearGuestSession } from "./preview-guest-session";

export type DriveEntryResult =
  | { kind: "enter"; choir: ChoirSummary }
  | { kind: "display-name"; choir: ChoirSummary }
  | { kind: "none" }
  | { kind: "failed"; message: string; restart: boolean };
const unavailable = "暂时无法进入这个云盘，请稍后再试。";
const removed = "该成员关系需要有成员恢复权限的人恢复。";

async function continueGuest(guest: GuestSessionResponse, authenticated: boolean, signal?: AbortSignal): Promise<DriveEntryResult> {
  if (!authenticated) return { kind: "enter", choir: guest.choir };
  if (guest.entryKind === "preview") {
    await clearGuestSession();
    signal?.throwIfAborted();
    return { kind: "enter", choir: guest.choir };
  }
  const response = await diagnosticFetch("/api/choirs/current-guest/join-state", { signal });
  if (!response.ok) {
    const restart = response.status === 401 || response.status === 403;
    if (restart) await clearGuestSession();
    return { kind: "failed", message: response.status === 403 ? removed : unavailable, restart };
  }
  const state = await parseDiagnosticResponse(response, guestJoinStateResponseSchema);
  signal?.throwIfAborted();
  if (state.status === "joined") {
    await clearGuestSession();
    signal?.throwIfAborted();
    return { kind: "enter", choir: state.choir };
  }
  return { kind: "display-name", choir: state.choir };
}

export async function enterDrive(admission: GuestAdmissionRequest, authenticated: boolean, signal?: AbortSignal): Promise<DriveEntryResult> {
  try {
    const response = await diagnosticFetch("/api/guest/session", {
      method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(admission),
    });
    if (!response.ok) return { kind: "failed", restart: true, message: response.status === 429 ? "尝试次数过多，请稍后再试。" : response.status >= 500 ? unavailable : "邀请码无效或已失效。" };
    const guest = await parseDiagnosticResponse(response, guestSessionResponseSchema);
    signal?.throwIfAborted();
    return await continueGuest(guest, authenticated, signal);
  } catch { return { kind: "failed", message: unavailable, restart: false }; }
}

export async function resumeDriveEntry(signal?: AbortSignal): Promise<DriveEntryResult> {
  try {
    const response = await diagnosticFetch("/api/guest/session", { signal });
    if (response.status === 401 || response.status === 404) return { kind: "none" };
    if (!response.ok) return { kind: "failed", message: unavailable, restart: false };
    const guest = await parseDiagnosticResponse(response, guestSessionResponseSchema);
    signal?.throwIfAborted();
    return await continueGuest(guest, true, signal);
  } catch { return { kind: "failed", message: unavailable, restart: false }; }
}

export async function joinDrive(target: { kind: "guest"; choirId: string } | { kind: "open"; choirId: string }, displayName: string, signal?: AbortSignal): Promise<DriveEntryResult> {
  try {
    const response = await diagnosticFetch(target.kind === "guest" ? "/api/choirs/join-current-guest" : "/api/choirs/join", {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify(target.kind === "guest" ? { displayName } : { admission: "open", choirId: target.choirId, displayName }),
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      if (payload?.error === "member_limit_reached") return { kind: "failed", restart: false, message: trialMessage(payload.error) };
      const restart = response.status === 401 || response.status === 403;
      if (restart && target.kind === "guest") await clearGuestSession();
      return { kind: "failed", restart, message: response.status === 403 ? removed : "暂时无法加入这个云盘，请稍后再试。" };
    }
    await clearGuestSession();
    signal?.throwIfAborted();
    return { kind: "enter", choir: { id: target.choirId, name: "", guestAdmissionMode: target.kind === "guest" ? "invite" : "open" } };
  } catch { return { kind: "failed", restart: false, message: "暂时无法加入这个云盘，请稍后再试。" }; }
}

export async function openDriveAdmission(choirId: string, authenticated: boolean, signal: AbortSignal): Promise<DriveEntryResult> {
  try {
    const response = await diagnosticFetch(`/api/guest/choirs/${choirId}`, { signal });
    if (response.status === 404) return { kind: "none" };
    if (!response.ok) return { kind: "failed", message: unavailable, restart: false };
    const admission = await parseDiagnosticResponse(response, guestSessionResponseSchema);
    signal.throwIfAborted();
    if (authenticated && admission.entryKind !== "preview") return { kind: "display-name", choir: admission.choir };
    return enterDrive({ admission: "open", choirId }, authenticated, signal);
  } catch { return { kind: "failed", message: unavailable, restart: false }; }
}

// Wait for a session-creating request to settle before deleting its credential.
// Aborting fetch alone cannot guarantee that the server did not set a cookie.
export async function cancelDriveEntry(pending: Promise<unknown> | null) {
  await pending?.catch(() => undefined);
  await clearGuestSession();
}
