
export const sharedLayerDescriptions = {
  E: "全体",
  S: "女高音",
  A: "女低音",
  T: "男高音",
  B: "男低音",
};

export class SettingsRequestError extends Error {
  constructor(readonly status: number) {
    super("settings_request_failed");
  }
}

export async function settingsResponse(response: Response) {
  if (!response.ok) throw new SettingsRequestError(response.status);
  return response.json() as Promise<unknown>;
}

export function settingsError(error: unknown, fallback: string) {
  if (error instanceof SettingsRequestError) {
    if (error.status === 401) return "登录已失效，请重新登录后再试。";
    if (error.status === 403) return "你没有操作此设置的权限，请联系云盘管理员。";
  }
  return fallback;
}
