export function SettingsFeedback({
  loading,
  loadError,
  message,
  retry,
}: {
  loading: boolean;
  loadError: string | null;
  message: string | null;
  retry: () => void;
}) {
  if (loadError) {
    return (
      <div className="settings-feedback" role="alert">
        {message && <p>{message}</p>}
        <p>{loadError}</p>
        <button className="secondary-button" type="button" onClick={retry}>重新加载</button>
      </div>
    );
  }
  return (
    <p className="settings-feedback settings-feedback--status" role="status">
      {loading ? "正在读取设置…" : message ?? ""}
    </p>
  );
}
