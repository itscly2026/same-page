import { lifecycleError } from "../auth/lifecycle-error";
import { SettingsRequestError, settingsError } from "./settings-request";

export type SettingsMutationResult =
  | { kind: "saved" }
  | { kind: "saved-refresh-failed"; error: unknown }
  | { kind: "failed" | "unconfirmed" | "revoked"; error: unknown };

// A successful HTTP response confirms the write even if reading its body,
// updating local state or refreshing the view subsequently fails.
export async function runSettingsMutation(
  request: () => Promise<Response>,
  afterSave?: (response: Response) => Promise<void>,
): Promise<SettingsMutationResult> {
  let response: Response;
  try { response = await request(); }
  catch (error) { return { kind: "unconfirmed", error }; }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { kind: response.status === 401 || response.status === 403 ? "revoked" : "failed", error: new SettingsRequestError(response.status, typeof body?.error === "string" ? body.error : undefined) };
  }
  try { await afterSave?.(response); return { kind: "saved" }; }
  catch (error) { return { kind: "saved-refresh-failed", error }; }
}

export function settingsMutationMessage(result: SettingsMutationResult, saved = "已保存。") {
  switch (result.kind) {
    case "saved": return saved;
    case "saved-refresh-failed": return `${saved}但刷新失败，请重新读取最新状态，不必再次提交。${result.error instanceof SettingsRequestError && [401, 403].includes(result.error.status) ? settingsError(result.error, "") : ""}`;
    case "failed": return result.error instanceof SettingsRequestError && result.error.code ? lifecycleError(result.error.code) : "保存失败，修改已保留，请核对后重试。";
    case "unconfirmed": return "操作结果未确认，请重新读取状态后再决定是否重试。";
    case "revoked": return settingsError(result.error, "操作权限已撤销。");
  }
}
