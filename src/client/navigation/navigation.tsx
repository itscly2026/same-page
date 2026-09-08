import { holdUpdate } from "../updates/update-safety";
import { RouterProvider as AriaRouterProvider } from "react-aria-components";
import { useContext, useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { UNSAFE_DataRouterContext, useBlocker, useLocation, useNavigate, useNavigationType, useHref } from "react-router-dom";

import { Context, type Exit } from "./navigation-context";

export function NavigationProvider({ children }: { children: ReactNode }) {
  const entries = useRef<Exit[]>([]);
  const [returnState] = useState(() => new Map<string, unknown>());
  const [formsOnly, setFormsOnly] = useState(false);
  const [activeCount, update] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const retryAction = useRef<(() => void) | null>(null);
  const setRetry = useCallback((retry: (() => void) | null) => { retryAction.current = retry; }, []);
  const running = useRef<Promise<boolean> | null>(null);
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const history = useRef<string[]>([]);
  const latestIntent = useRef(0);
  const checkpointOriginal = useRef<string | null>(null);
  const pendingFallback = useRef<string | null>(null);
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  // A deep link has no same-document back entry. Give its first local exit
  // layer one temporary checkpoint; an unguarded back skips the duplicate.
  useEffect(() => {
    if (!dataRouter || !activeCount || window.history.state?.idx !== 0 || location.state?.exitCheckpoint) return;
    checkpointOriginal.current = location.key;
    void navigate(location.pathname + location.search + location.hash, { state: { ...location.state, exitCheckpoint: location.key } });
  }, [activeCount, dataRouter, location, navigate]);
  useLayoutEffect(() => {
    if (location.state?.exitCheckpoint) checkpointOriginal.current = location.state.exitCheckpoint;
    if (type !== "POP" || location.key !== checkpointOriginal.current) return;
    checkpointOriginal.current = null;
    const fallback = pendingFallback.current;
    pendingFallback.current = null;
    if (fallback) void navigate(fallback, { replace: true });
    else void navigate(-1);
  }, [location, navigate, type]);
  useLayoutEffect(() => {
    latestIntent.current++;
    const index = history.current.indexOf(location.key);
    if (index >= 0) history.current = history.current.slice(0, index + 1);
    else if (type === "REPLACE") history.current.splice(-1, 1, location.key);
    else history.current.push(location.key);
  }, [location.key, type]);
  const register = useCallback((exit: Exit) => {
    const releaseUpdate = holdUpdate();
    entries.current.push(exit); update(entries.current.length); setFormsOnly(entries.current.every(item => item.kind === "form"));
    return () => { releaseUpdate(); entries.current = entries.current.filter(item => item !== exit); update(entries.current.length); setFormsOnly(entries.current.length > 0 && entries.current.every(item => item.kind === "form")); };
  }, []);
  const consume = (all: boolean): Promise<boolean> => {
    if (running.current) return running.current;
    const releaseUpdate = holdUpdate();
    running.current = Promise.resolve().then(async () => {
    retryAction.current = null;
    setMessage(null);
    try {
      const ordered = [...entries.current].reverse().sort((a, b) => Number(b.kind === "overlay") - Number(a.kind === "overlay"));
      for (const entry of ordered) {
        const result = await entry.leave(all);
        if (result === "cancelled") return false;
        if (!result) { setMessage("本机保存未完成，请保留当前页面并重试。"); return false; }
        if (!all) break;
      }
      return true;
    } catch { setMessage("退出未完成，请重试；当前内容仍保留。"); return false; }
    }).finally(() => { running.current = null; releaseUpdate(); });
    return running.current;
  };
  const leaveRoute = (fallback: string) => {
    if (location.state?.exitCheckpoint) { pendingFallback.current = fallback; void navigate(-1); return; }
    if (history.current.length > 1 || (window.history.state?.idx ?? 0) > 0) void navigate(-1);
    else void navigate(fallback, { replace: true });
  };
  const back = (fallback: string) => {
    if (!entries.current.length) { leaveRoute(fallback); return; }
    if (entries.current.every(entry => entry.kind === "form")) {
      void consume(true).then(ok => { if (ok) leaveRoute(fallback); });
    } else void consume(false);
  };
  const afterEditing = (action: () => void) => {
    const intent = ++latestIntent.current;
    void consume(true).then(ok => { if (ok && intent === latestIntent.current) action(); });
  };
  return <AriaRouterProvider navigate={(to, options) => { void navigate(to, options); }} useHref={useHref}><Context value={{ register, back, afterEditing, returnState }}>
    {dataRouter && <HistoryExit routeExit={formsOnly} active={activeCount > 0} consume={consume} setRetry={setRetry} />}
    {children}
    {message && <aside className="navigation-error" role="alert">{message}<button onClick={() => { if (retryAction.current) retryAction.current(); else void consume(false); }}>重试</button></aside>}
  </Context></AriaRouterProvider>;
}

function HistoryExit({ active, consume, setRetry, routeExit }: { routeExit: boolean; active: boolean; consume(all: boolean): Promise<boolean>; setRetry(retry: (() => void) | null): void }) {
  const navigate = useNavigate();
  const action = useRef<"POP" | "PUSH" | "REPLACE">("POP");
  const blocker = useBlocker(({ historyAction, currentLocation, nextLocation }) => {
    if (historyAction === "PUSH" && nextLocation.state?.exitCheckpoint === currentLocation.key && nextLocation.pathname === currentLocation.pathname && nextLocation.search === currentLocation.search && nextLocation.hash === currentLocation.hash) return false;
    action.current = historyAction; return active;
  });
  const processing = useRef(false);
  const latest = useRef(blocker);
  useLayoutEffect(() => { latest.current = blocker; });
  const handled = useRef<typeof blocker | null>(null);
  useEffect(() => {
    if (blocker.state !== "blocked" || processing.current || handled.current === blocker) return;
    handled.current = blocker;
    processing.current = true;
    const internal = action.current !== "POP" || routeExit;
    // Reset a history gesture immediately: it consumes a local level, never a route.
    if (!internal) blocker.reset();
    void consume(internal).then(ok => {
      if (internal && latest.current.state === "blocked") {
        const pending = latest.current;
        if (ok && internal) pending.proceed();
        else {
          const replace = action.current === "REPLACE";
          pending.reset();
          if (!ok) setRetry(() => { void navigate(pending.location, { replace, state: pending.location.state }); });
        }
      }
    }).finally(() => { processing.current = false; });
  }, [blocker, consume, navigate, setRetry, routeExit]);
  return null;
}

