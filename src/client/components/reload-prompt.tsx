import { Button } from "react-aria-components";
import { useRegisterSW } from "virtual:pwa-register/react";

export function ReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh && !offlineReady) {
    return null;
  }

  const close = () => {
    setNeedRefresh(false);
    setOfflineReady(false);
  };

  return (
    <aside className="update-prompt" aria-live="polite">
      <p>{needRefresh ? "有新版本可用" : "应用已可离线打开"}</p>
      <div className="update-prompt__actions">
        {needRefresh ? (
          <Button onPress={() => void updateServiceWorker(true)}>更新</Button>
        ) : null}
        <Button onPress={close}>关闭</Button>
      </div>
    </aside>
  );
}
