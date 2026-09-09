import { useEffect, useState } from "react";
import { userLifecycleSchema } from "../../shared/lifecycle";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { useSettingsMutation } from "./settings-mutation";
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
  const [loading, setLoading] = useState(true);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const read = async (isCurrent: () => boolean) => {
    setLoading(true);
    try {
      const next = await loadUserLifecycle();
      if (isCurrent()) { setState(next); setNeedsRefresh(false); setMessage(null); }
    } catch (error) {
      if (isCurrent()) {
        setNeedsRefresh(true);
        if (error instanceof SettingsRequestError && [401, 403].includes(error.status)) setState(null);
        setMessage(settingsError(error, "暂时无法读取用户状态，请重试。"));
      }
      throw error;
    } finally { if (isCurrent()) setLoading(false); }
  };
  useEffect(() => {
    const isCurrent = captureSettingsLifetime(lifetime);
    void loadUserLifecycle().then(next => {
      if (isCurrent()) { setState(next); setLoading(false); }
    }).catch(error => {
      if (isCurrent()) { setLoading(false); setNeedsRefresh(true); setMessage(settingsError(error, "暂时无法读取用户状态，请重试。")); }
    });
  }, [lifetime]);
  const mutation = useSettingsMutation({ enabled: !loading && !needsRefresh, refresh: read, onRevoked: () => setState(null) });
  const perform = async (path: string, body: unknown, complete?: (isCurrent: () => boolean) => Promise<void>) => {
    setMessage(null);
    await mutation.submit(
      () => diagnosticFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { confirmed: complete ? (_response, isCurrent) => complete(isCurrent) : undefined, refresh: !complete, successMessage: complete ? undefined : "已保存。" },
    );
  };
  return { state, setState, message: mutation.message ?? message, setMessage, busy: mutation.pending, loading, blocked: mutation.blocked, reload: mutation.refresh, perform };
}
