import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { useRegisterSW } from "virtual:pwa-register/react";

export function ReloadPrompt() {
  const [registrationAttempt, setRegistrationAttempt] = useState(0);
  const retryRegistration = useCallback(() => setRegistrationAttempt((value) => value + 1), []);
  return <RegisteredReloadPrompt key={registrationAttempt} retryRegistration={retryRegistration} />;
}

function RegisteredReloadPrompt({ retryRegistration }: { retryRegistration: () => void }) {
  const [registration, setRegistration] =
    useState<ServiceWorkerRegistration | null>(null);
  const [updateState, setUpdateState] = useState<
    | { phase: "idle" }
    | { phase: "updating" }
    | { phase: "checking" }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const updateTimeout = useRef<number | null>(null);
  const checkingUpdate = useRef(false);
  const applyingUpdate = useRef(false);
  const dismissedError = useRef(false);
  const actionEpoch = useRef(0);
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
    updateServiceWorker,
  } = useRegisterSW({
    onNeedReload,
    onRegisteredSW,
    onRegisterError: () => {
      setUpdateState({
        phase: "error",
        message: "应用离线资源准备失败，请重试",
      });
    },
  });

  const checkForUpdate = useCallback(async (explicit = false) => {
    if (explicit && !navigator.onLine) {
      setUpdateState({ phase: "error", message: "当前离线，联网后可重试更新" });
      return;
    }
    if (explicit && !registration) {
      retryRegistration();
      return;
    }
    if (
      !registration ||
      applyingUpdate.current ||
      checkingUpdate.current ||
      registration.installing ||
      !navigator.onLine
    ) {
      return;
    }
    const epoch = actionEpoch.current;
    checkingUpdate.current = true;
    if (explicit) { dismissedError.current = false; setUpdateState({ phase: "checking" }); }
    try {
      await registration.update();
      if (epoch !== actionEpoch.current) return;
      setUpdateState((current) =>
        explicit && (current.phase === "error" || current.phase === "checking") ? { phase: "idle" } : current,
      );
    } catch {
      if (epoch === actionEpoch.current && (explicit || !dismissedError.current)) setUpdateState({
        phase: "error",
        message: "更新检查失败，请稍后重试",
      });
    } finally {
      checkingUpdate.current = false;
    }
  }, [registration, retryRegistration]);

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

  if (!needRefresh && updateState.phase !== "error" && updateState.phase !== "checking") {
    return null;
  }

  const close = () => {
    actionEpoch.current += 1;
    clearUpdateTimeout();
    setUpdateState({ phase: "idle" });
    setNeedRefresh(false);
    dismissedError.current = true;
    applyingUpdate.current = false;
  };

  const applyUpdate = async () => {
    if (applyingUpdate.current) return;
    const epoch = actionEpoch.current;
    if (!navigator.onLine) {
      setUpdateState({
        phase: "error",
        message: "当前离线，联网后可重试更新",
      });
      return;
    }
    if (!registration?.waiting) {
      await checkForUpdate(true);
      if (epoch !== actionEpoch.current) return;
      if (registration?.waiting) return applyUpdate();
      setUpdateState({
        phase: "error",
        message: "更新尚未准备好，请重试",
      });
      return;
    }

    clearUpdateTimeout();
    applyingUpdate.current = true;
    setUpdateState({ phase: "updating" });
    updateTimeout.current = window.setTimeout(() => {
      updateTimeout.current = null;
      applyingUpdate.current = false;
      setUpdateState({
        phase: "error",
        message: "更新接管超时，请重试",
      });
    }, 10_000);
    try {
      await updateServiceWorker(true);
    } catch {
      if (epoch !== actionEpoch.current) return;
      applyingUpdate.current = false;
      clearUpdateTimeout();
      setUpdateState({
        phase: "error",
        message: "更新失败，请重试",
      });
    }
  };

  const message = updateState.phase === "updating"
    ? "正在更新…"
    : updateState.phase === "checking" ? "正在检查应用更新…"
    : updateState.phase === "error"
      ? updateState.message
      : needRefresh
        ? "有新版本可用"
        : "应用资源已准备好";

  return (
    <aside className="update-prompt" aria-live="polite">
      <p>{message}</p>
      <div className="update-prompt__actions">
        {needRefresh ? (
          <Button
            isDisabled={updateState.phase === "updating" || updateState.phase === "checking"}
            onPress={() => void applyUpdate()}
          >
            {updateState.phase === "error" ? "重试" : "更新"}
          </Button>
        ) : updateState.phase === "error" ? (
          <Button onPress={() => void checkForUpdate(true)}>重试</Button>
        ) : null}
        <Button onPress={close}>关闭</Button>
      </div>
    </aside>
  );
}
