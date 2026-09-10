import { useEffect, useState, useRef } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { ReaderSession, type ReaderSessionSnapshot } from "./reader-session";

const initial: ReaderSessionSnapshot = { mode: "pdf", modeMessage: null, score: null, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null, preparation: { phase: "idle" } };

export function useReaderSession(workspace: LocalWorkspace | null, userId: string | null, sessionId: string | null) {
  const initialUser = useRef({ userId, sessionId });
  useEffect(() => { initialUser.current = { userId, sessionId }; }, [userId, sessionId]);
  const [attempt, setAttempt] = useState(0);
  const [current, setCurrent] = useState<{ session: ReaderSession; snapshot: ReaderSessionSnapshot } | null>(null);
  useEffect(() => {
    if (!workspace) return;
    const session = new ReaderSession(workspace, initialUser.current.userId, initialUser.current.sessionId);
    const unsubscribe = session.subscribe(() => setCurrent({ session, snapshot: session.getSnapshot() }));
    session.open();
    return () => {
      unsubscribe();
      session.dispose();
    };
  }, [workspace, attempt]);
  useEffect(() => {
    current?.session.setAuthenticatedUser(userId, sessionId);
  }, [current?.session, userId, sessionId]);
  const active = current?.session.workspace.scopeKey === workspace?.scopeKey ? current : null;
  return { presentation: active?.session.presentation ?? null, retry: () => { if (!active?.session.retryPdf()) setAttempt(value => value + 1); }, snapshot: active?.snapshot ?? initial, download: () => active?.session.download(), retryLayers: () => active?.session.retryLayers() };
}
