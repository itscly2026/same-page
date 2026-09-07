import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useRegisterSW } from "virtual:pwa-register/react";
import { canApplyUpdate, noteUpdateInteraction, setUpdateRoute } from "../updates/update-safety";
import { setUpdateStatus, useUpdateStatus } from "../updates/update-status";

export function ReloadPrompt() {
  const [attempt, setAttempt] = useState(0);
  const retryRegistration = useCallback(() => setAttempt(value => value + 1), []);
  return <RegisteredReloadPrompt key={attempt} retryRegistration={retryRegistration} />;
}

function RegisteredReloadPrompt({ retryRegistration }: { retryRegistration(): void }) {
  const { pathname } = useLocation();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const reloadPending = useRef(false);
  const applying = useRef(false);
  const failed = useRef(false);
  const onNeedReload = useCallback(() => {
    reloadPending.current = true;
    // Also check on this side of activation: a user may have started interacting
    // after the worker's probe. Never refresh a reader or an unsaved operation.
    if (canApplyUpdate()) window.location.reload();
  }, []);
  const onRegisteredSW = useCallback((_url: string, value?: ServiceWorkerRegistration) => setRegistration(value), []);
  const { needRefresh: [ready] } = useRegisterSW({ onNeedReload, onRegisteredSW,
    onRegisterError: () => { failed.current = true; setUpdateStatus("应用离线资源准备失败，请稍后重试"); },
  });
  useLayoutEffect(() => setUpdateRoute(pathname), [pathname]);
  const check = useCallback(async () => {
    if (!navigator.onLine) { setUpdateStatus("当前离线，继续使用当前版本"); return; }
    if (!registration) { setUpdateStatus("正在重新准备离线资源…"); retryRegistration(); return; }
    failed.current = false;
    setUpdateStatus("正在检查更新…");
    try { await registration.update(); setUpdateStatus(registration.waiting ? "新版本已准备，将在安全时应用" : "检查完成，当前版本继续运行"); }
    catch { failed.current = true; setUpdateStatus("更新检查失败，请稍后重试"); }
  }, [registration, retryRegistration]);
  useEffect(() => {
    if (ready) setUpdateStatus("新版本已准备，将在安全时应用");
  }, [ready]);
  useEffect(() => {
    if (registration) void check();
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("same-page-check-update", check);
    return () => { document.removeEventListener("visibilitychange", visible); window.removeEventListener("same-page-check-update", check); };
  }, [registration, check]);
  useEffect(() => {
    const events = ["pointerdown", "pointerup", "keydown", "input", "focusin", "wheel", "scroll"] as const;
    events.forEach(event => document.addEventListener(event, noteUpdateInteraction, true));
    const probe = (event: MessageEvent) => {
      if (event.data?.type === "SAME_PAGE_UPDATE_PROBE") event.ports[0]?.postMessage(canApplyUpdate());
    };
    navigator.serviceWorker?.addEventListener("message", probe);
    const timer = window.setInterval(() => {
      if (!canApplyUpdate()) return;
      if (reloadPending.current) { window.location.reload(); return; }
      if (!ready || !registration?.waiting || applying.current || failed.current) return;
      applying.current = true;
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => {
        applying.current = false; failed.current = true; channel.port1.close();
        setUpdateStatus("更新未完成，当前版本继续运行；可重新检查更新");
      }, 10000);
      channel.port1.onmessage = event => {
        if (event.data?.safe === true) { setUpdateStatus("正在应用更新…"); return; }
        clearTimeout(timeout); channel.port1.close(); applying.current = false;
        setUpdateStatus("新版本待应用，请先完成其他窗口中的操作");
      };
      registration.waiting.postMessage({ type: "SAME_PAGE_SAFE_UPDATE" }, [channel.port2]);
    }, 1000);
    return () => { clearInterval(timer); events.forEach(event => document.removeEventListener(event, noteUpdateInteraction, true)); navigator.serviceWorker?.removeEventListener("message", probe); };
  }, [ready, registration]);
  return null;
}

export function UpdateDetails() {
  const status = useUpdateStatus();
  return <section><h2>版本更新</h2><p role="status">{status}</p><button className="secondary-button" onClick={() => window.dispatchEvent(new Event("same-page-check-update"))}>检查更新</button></section>;
}
