import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { useRegisterSW } from "virtual:pwa-register/react";

export function ReloadPrompt() {
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [updateState, setUpdateState] = useState<
    | { phase: "idle" }
    | { phase: "updating" }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const updateTimeout = useRef<number | null>(null);
  const checkingUpdate = useRef(false);
  const clearUpdateTimeout = useCallback(() => {
    if (updateTimeout.current === null) return;
    window.clearTimeout(updateTimeout.current);
    updateTimeout.current = null;
  }, []);
  const onNeedReload = useCallback(() => {
    clearUpdateTimeout();
    window.location.reload();
  }, [clearUpdateTimeout]);
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
  } = useRegisterSW({
    onNeedReload,
    onRegisteredSW,
    onRegisterError: () => {
      setUpdateState({
        phase: "error",
        message: "更新检查失败，请稍后重试",
      });
    },
  });

  const checkForUpdate = useCallback(async () => {
    if (
      !registration ||
      checkingUpdate.current ||
      registration.installing ||
      !navigator.onLine
    ) {
      return;
    }
    checkingUpdate.current = true;
    try {
      await registration.update();
      setUpdateState((current) =>
        current.phase === "error" ? { phase: "idle" } : current,
      );
    } catch {
      setUpdateState({
        phase: "error",
        message: "更新检查失败，请稍后重试",
      });
    } finally {
      checkingUpdate.current = false;
    }
  }, [registration]);

  useEffect(() => {
    if (!registration) return;
    let active = true;
    const onVisibilityChange = () => {
      if (active && document.visibilityState === "visible") void checkForUpdate();
    };

    const initialCheck = window.setTimeout(() => void checkForUpdate(), 0);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearTimeout(initialCheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkForUpdate, registration]);

  useEffect(() => clearUpdateTimeout, [clearUpdateTimeout]);

  if (!needRefresh && !offlineReady && updateState.phase !== "error") {
    return null;
  }

  const close = () => {
    clearUpdateTimeout();
    setUpdateState({ phase: "idle" });
    setNeedRefresh(false);
    setOfflineReady(false);
  };

  const applyUpdate = async () => {
    if (!navigator.onLine) {
      setUpdateState({
        phase: "error",
        message: "当前离线，联网后可重试更新",
      });
      return;
    }
    if (!registration?.waiting) {
      setUpdateState({
        phase: "error",
        message: "更新尚未准备好，请重试",
      });
      return;
    }

    clearUpdateTimeout();
    setUpdateState({ phase: "updating" });
    updateTimeout.current = window.setTimeout(() => {
      updateTimeout.current = null;
      setUpdateState({
        phase: "error",
        message: "更新接管超时，请重试",
      });
    }, 10_000);
    try {
      await updateServiceWorker(true);
    } catch {
      clearUpdateTimeout();
      setUpdateState({
        phase: "error",
        message: "更新失败，请重试",
      });
    }
  };

  const message = updateState.phase === "updating"
    ? "正在更新…"
    : updateState.phase === "error"
      ? updateState.message
      : needRefresh
        ? "有新版本可用"
        : "应用已可离线打开";

  return (
    <aside className="update-prompt" aria-live="polite">
      <p>{message}</p>
      <div className="update-prompt__actions">
        {needRefresh ? (
          <Button
            isDisabled={updateState.phase === "updating"}
            onPress={() => void applyUpdate()}
          >
            {updateState.phase === "error" ? "重试" : "更新"}
          </Button>
        ) : updateState.phase === "error" ? (
          <Button onPress={() => void checkForUpdate()}>重试</Button>
        ) : null}
        <Button onPress={close}>关闭</Button>
      </div>
    </aside>
  );
}
