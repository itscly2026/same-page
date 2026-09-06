import { RouterProvider as AriaRouterProvider } from "react-aria-components";
import { useContext, useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { UNSAFE_DataRouterContext, useBlocker, useLocation, useNavigate, useNavigationType, useHref } from "react-router-dom";

import { Context, type Exit } from "./navigation-context";

export function NavigationProvider({ children }: { children: ReactNode }) {
  const entries = useRef<Exit[]>([]);
  const [activeCount, update] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const running = useRef<Promise<boolean> | null>(null);
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const history = useRef<string[]>([]);
  const latestIntent = useRef(0);
  useLayoutEffect(() => {
    latestIntent.current++;
    const index = history.current.indexOf(location.key);
    if (index >= 0) history.current = history.current.slice(0, index + 1);
    else if (type === "REPLACE") history.current.splice(-1, 1, location.key);
    else history.current.push(location.key);
  }, [location.key, type]);
  const register = useCallback((exit: Exit) => {
    entries.current.push(exit); update(entries.current.length);
    return () => { entries.current = entries.current.filter(item => item !== exit); update(entries.current.length); };
  }, []);
  const consume = (all: boolean): Promise<boolean> => {
    if (running.current) return running.current;
    running.current = (async () => {
    setMessage(null);
    try {
      const ordered = [...entries.current].reverse().sort((a, b) => Number(b.kind === "overlay") - Number(a.kind === "overlay"));
      for (const entry of ordered) {
        if (!await entry.leave()) { setMessage("本机保存未完成，请保留当前页面并重试。"); return false; }
        if (!all) break;
      }
      return true;
    } catch { setMessage("退出未完成，请重试；当前内容仍保留。"); return false; }
    finally { running.current = null; }
    })();
    return running.current;
  };
  const back = (fallback: string) => {
    if (entries.current.length) { void consume(false); return; }
    if (history.current.length > 1 || (window.history.state?.idx ?? 0) > 0) void navigate(-1);
    else void navigate(fallback, { replace: true });
  };
  const afterEditing = (action: () => void) => {
    const intent = ++latestIntent.current;
    void consume(true).then(ok => { if (ok && intent === latestIntent.current) action(); });
  };
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return <AriaRouterProvider navigate={(to, options) => { void navigate(to, options); }} useHref={useHref}><Context value={{ register, back, afterEditing }}>
    {dataRouter && <HistoryExit active={activeCount > 0} consume={consume} />}
    {children}
    {message && <aside className="navigation-error" role="alert">{message}<button onClick={() => { void consume(false); }}>重试</button></aside>}
  </Context></AriaRouterProvider>;
}

function HistoryExit({ active, consume }: { active: boolean; consume(all: boolean): Promise<boolean> }) {
  const action = useRef<"POP" | "PUSH" | "REPLACE">("POP");
  const blocker = useBlocker(({ historyAction }) => { action.current = historyAction; return active; });
  const processing = useRef(false);
  const latest = useRef(blocker);
  useLayoutEffect(() => { latest.current = blocker; });
  const handled = useRef<typeof blocker | null>(null);
  useEffect(() => {
    if (blocker.state !== "blocked" || processing.current || handled.current === blocker) return;
    handled.current = blocker;
    processing.current = true;
    const internal = action.current !== "POP";
    // Reset a history gesture immediately: it consumes a local level, never a route.
    if (!internal) blocker.reset();
    void consume(internal).then(ok => {
      if (internal && latest.current.state === "blocked") { if (ok && action.current !== "POP") latest.current.proceed(); else latest.current.reset(); }
    }).finally(() => { processing.current = false; });
  }, [blocker, consume]);
  return null;
}

