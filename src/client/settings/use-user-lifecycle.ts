import { useCallback, useEffect, useState } from "react";
import { userLifecycleSchema } from "../../shared/lifecycle";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { runSettingsMutation, settingsMutationMessage } from "./settings-mutation";
import { SettingsRequestError, settingsError } from "./settings-request";
import { useSettingsLifetime, captureSettingsLifetime } from "./use-settings-lifetime";

async function loadUserLifecycle() {
  const response = await diagnosticFetch("/api/user/lifecycle", { cache: "no-store" });
  if (!response.ok) throw new SettingsRequestError(response.status);
  return parseDiagnosticResponse(response, userLifecycleSchema);
}

export function useUserLifecycle() {
  const lifetime = useSettingsLifetime();
  const [state, setState] = useState<ReturnType<typeof userLifecycleSchema.parse> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const reload = useCallback(async () => {
    const isCurrent = captureSettingsLifetime(lifetime);
    try {
      const next = await loadUserLifecycle();
      if (isCurrent()) { setState(next); setNeedsRefresh(false); }
    } catch (error) {
      if (isCurrent()) {
        setNeedsRefresh(true);
        if (error instanceof SettingsRequestError && [401, 403].includes(error.status)) setState(null);
        setMessage(settingsError(error, "暂时无法读取用户状态，请重试。"));
      }
      throw error;
    }
  }, [lifetime]);
  useEffect(() => {
    const isCurrent = captureSettingsLifetime(lifetime);
    void loadUserLifecycle().then(next => {
      if (isCurrent()) setState(next);
    }).catch(error => {
      if (isCurrent()) { setNeedsRefresh(true); setMessage(settingsError(error, "暂时无法读取用户状态，请重试。")); }
    });
  }, [lifetime]);
  const perform = async (path: string, body: unknown, complete?: (isCurrent: () => boolean) => Promise<void>) => {
    if (busy || needsRefresh) return;
    const isCurrent = captureSettingsLifetime(lifetime);
    setBusy(true); setMessage(null);
    const result = await runSettingsMutation(
      () => diagnosticFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      async () => { if (isCurrent()) await (complete ? complete(isCurrent) : reload()); },
    );
    if (!isCurrent()) return;
    if (!complete || result.kind !== "saved") setMessage(settingsMutationMessage(result));
    if (result.kind === "revoked") setState(null);
    if (["unconfirmed", "revoked", "saved-refresh-failed"].includes(result.kind)) setNeedsRefresh(true);
    setBusy(false);
  };
  return { state, setState, message, setMessage, busy, blocked: busy || needsRefresh, reload, perform };
}
