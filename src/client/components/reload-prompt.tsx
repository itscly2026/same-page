import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useRegisterSW } from "virtual:pwa-register/react";

export function ReloadPrompt() {
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const onRegisteredSW = useCallback(
    (_swUrl: string, nextRegistration: ServiceWorkerRegistration | undefined) => {
      setRegistration(nextRegistration ?? null);
    },
    [],
  );
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ onRegisteredSW });

  useEffect(() => {
    if (!registration) return;
    let active = true;
    let checking = false;
    const checkForUpdate = async () => {
      if (
        !active ||
        checking ||
        registration.installing ||
        !navigator.onLine
      ) {
        return;
      }
      checking = true;
      try {
        await registration.update();
      } catch {
        // A failed check must not interrupt offline use or app startup.
      } finally {
        checking = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkForUpdate();
    };

    void checkForUpdate();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [registration]);

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
