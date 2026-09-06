import { useEffect, useState, useRef } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { ReaderSession, type ReaderSessionSnapshot } from "./reader-session";

const initial: ReaderSessionSnapshot = { mode: "pdf", modeMessage: null, score: null, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null };

export function useReaderSession(workspace: LocalWorkspace | null, userId: string | null) {
  const initialUser = useRef(userId);
  useEffect(() => { initialUser.current = userId; }, [userId]);
  const [attempt, setAttempt] = useState(0);
  const [current, setCurrent] = useState<{ session: ReaderSession; snapshot: ReaderSessionSnapshot } | null>(null);
  useEffect(() => {
    if (!workspace) return;
    const session = new ReaderSession(workspace, initialUser.current);
    const unsubscribe = session.subscribe(() => setCurrent({ session, snapshot: session.getSnapshot() }));
    session.open();
    const refresh = () => { void session.refresh(); };
    // Refresh score access before pulling subscriptions, including trash and membership changes.
    const timer = window.setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible") refresh();
    }, 30_000);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      unsubscribe();
      session.dispose();
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspace, attempt]);
  useEffect(() => {
    current?.session.setAuthenticatedUser(userId);
  }, [current?.session, userId]);
  const active = current?.session.workspace.scopeKey === workspace?.scopeKey ? current : null;
  return { confirmDisplay: (document: import("./image-document").ScoreDocument) => active?.session.confirmDisplay(document), recoverDisplay: (error: unknown) => active?.session.recoverDisplay(error), retry: () => setAttempt(value => value + 1), snapshot: active?.snapshot ?? initial, download: () => active?.session.download(), retryLayers: () => active?.session.retryLayers() };
}
