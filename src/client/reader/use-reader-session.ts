import { useEffect, useState } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { ReaderSession, type ReaderSessionSnapshot } from "./reader-session";

const initial: ReaderSessionSnapshot = { score: null, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null };

export function useReaderSession(workspace: LocalWorkspace | null, userId: string | null) {
  const [current, setCurrent] = useState<{ session: ReaderSession; snapshot: ReaderSessionSnapshot } | null>(null);
  useEffect(() => {
    if (!workspace) return;
    const session = new ReaderSession(workspace, userId);
    const unsubscribe = session.subscribe(() => setCurrent({ session, snapshot: session.getSnapshot() }));
    session.open();
    const refresh = () => { void session.refresh(); };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      unsubscribe();
      session.dispose();
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [workspace, userId]);
  const active = current?.session.workspace.scopeKey === workspace?.scopeKey ? current : null;
  return { snapshot: active?.snapshot ?? initial, download: () => active?.session.download(), retryLayers: () => active?.session.retryLayers() };
}
