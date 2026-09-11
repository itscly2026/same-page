import { useRef, useState } from "react";
import { lifecycleError } from "../auth/lifecycle-error";
import { SettingsRequestError, settingsError } from "./settings-request";
import { captureSettingsLifetime, useSettingsLifetime } from "./use-settings-lifetime";

type MutationResult =
  | { kind: "saved" }
  | { kind: "saved-refresh-failed"; error: unknown }
  | { kind: "failed" | "unconfirmed" | "revoked"; error: unknown; message?: string };

type Current = () => boolean;
type Submission = {
  // Runs only after a confirmed write, before refreshing. Async domain work
  // checks isCurrent again after its own awaits before publishing effects.
  confirmed?: (response: Response, isCurrent: Current) => void | Promise<void>;
  refresh?: boolean;
  successMessage?: string;
  rejectionMessage?: (status: number, body: unknown) => string;
};

function mutationMessage(result: MutationResult) {
  switch (result.kind) {
    case "saved": return null;
    case "saved-refresh-failed": return `已保存。但刷新失败，请重新读取最新状态，不必再次提交。${result.error instanceof SettingsRequestError && [401, 403].includes(result.error.status) ? settingsError(result.error, "") : ""}`;
    case "failed": return result.message ?? (result.error instanceof SettingsRequestError && result.error.code ? lifecycleError(result.error.code) : "保存失败，修改已保留，请核对后重试。");
    case "unconfirmed": return "操作结果未确认，请重新读取状态后再决定是否重试。";
    case "revoked": return result.message ?? settingsError(result.error, "操作权限已撤销。");
  }
}

// Mount this hook inside the user/drive-keyed view. The same synchronous gate
// protects submissions and recovery reads, even before React renders pending.
export function useSettingsMutation({ enabled = true, refresh: read, onRevoked, initialRecovery }: {
  enabled?: boolean;
  initialRecovery?: "saved" | "unconfirmed";
  refresh: (isCurrent: Current) => Promise<void>;
  onRevoked?: () => void;
}) {
  const lifetime = useSettingsLifetime();
  const gate = useRef({ pending: false, needsRefresh: Boolean(initialRecovery) });
  const [pending, setPending] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(Boolean(initialRecovery));
  const [message, setMessage] = useState<string | null>(() => initialRecovery
    ? mutationMessage({ kind: initialRecovery === "saved" ? "saved-refresh-failed" : "unconfirmed", error: null })
    : null);
  const requireRefresh = (value: boolean) => {
    gate.current.needsRefresh = value;
    setNeedsRefresh(value);
  };
  const finish = () => { gate.current.pending = false; setPending(false); };

  // Only a successful read acknowledges uncertainty; a failed read keeps the
  // original write diagnosis so a confirmed save never looks like a failed save.
  const refresh = async () => {
    if (gate.current.pending) return false;
    const isCurrent = captureSettingsLifetime(lifetime);
    gate.current.pending = true; setPending(true);
    try {
      await read(isCurrent);
      if (isCurrent()) { requireRefresh(false); setMessage(null); return true; }
      return false;
    } catch (error) {
      if (isCurrent()) {
        requireRefresh(true);
        if (error instanceof SettingsRequestError && [401, 403].includes(error.status)) onRevoked?.();
        setMessage(previous => previous ?? settingsError(error, "暂时无法重新读取状态，请重试。"));
      }
      throw error;
    } finally { if (isCurrent()) finish(); }
  };

  // true: write and follow-up confirmed; false: current failure; null: no
  // submission or an obsolete completion. Callers never classify HTTP outcomes.
  const submit = async (request: () => Promise<Response>, submission: Submission = {}): Promise<boolean | null> => {
    if (!enabled || gate.current.pending || gate.current.needsRefresh) return null;
    const isCurrent = captureSettingsLifetime(lifetime);
    gate.current.pending = true; setPending(true); setMessage(null);
    let result: MutationResult;
    try {
      let response: Response;
      try { response = await request(); }
      catch (error) {
        result = { kind: "unconfirmed", error };
        return publish(result);
      }
      if (!isCurrent()) return null;
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        result = { kind: response.status >= 500 ? "unconfirmed" : response.status === 401 || response.status === 403 ? "revoked" : "failed", error: new SettingsRequestError(response.status, typeof body?.error === "string" ? body.error : undefined), message: submission.rejectionMessage?.(response.status, body) };
      } else {
        try {
          await submission.confirmed?.(response, isCurrent);
          if (!isCurrent()) return null;
          if (submission.refresh !== false) await read(isCurrent);
          result = { kind: "saved" };
        } catch (error) { result = { kind: "saved-refresh-failed", error }; }
      }
      return publish(result);
    } finally { if (isCurrent()) finish(); }

    function publish(outcome: MutationResult) {
      if (!isCurrent()) return null;
      const revoked = outcome.kind === "revoked" || (outcome.kind === "saved-refresh-failed" && outcome.error instanceof SettingsRequestError && [401, 403].includes(outcome.error.status));
      if (revoked) onRevoked?.();
      requireRefresh(outcome.kind === "unconfirmed" || outcome.kind === "revoked" || outcome.kind === "saved-refresh-failed" ||
        (outcome.kind === "failed" && outcome.error instanceof SettingsRequestError && [404, 409].includes(outcome.error.status)));
      setMessage(outcome.kind === "saved" ? submission.successMessage ?? null : mutationMessage(outcome));
      return outcome.kind === "saved";
    }
  };

  return { pending, needsRefresh, message, blocked: !enabled || pending || needsRefresh, submit, refresh };
}
