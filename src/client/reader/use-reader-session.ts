import { writeDisplayPreference } from "./display-preferences";
import { useEffect, useState } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { ReaderSession, type ReaderSessionSnapshot } from "./reader-session";

const initial: ReaderSessionSnapshot = { mode: "pdf", modeMessage: null, score: null, document: null, offline: null, cloudState: "checking", capability: "preparing", status: "loading", error: null, downloading: false, downloadMessage: null };

export function useReaderSession(workspace: LocalWorkspace | null, userId: string | null) {
  const [attempt, setAttempt] = useState(0);
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
  }, [workspace, userId, attempt]);
  const active = current?.session.workspace.scopeKey === workspace?.scopeKey ? current : null;
  return { confirmDisplay: (document: import("./image-document").ScoreDocument) => active?.session.confirmDisplay(document), recoverDisplay: (error: unknown) => active?.session.recoverDisplay(error), selectMode: (mode: "pdf" | "images") => {
    if (!active) return;
    if (active.snapshot.status === "error") {
      writeDisplayPreference(active.session.workspace, mode, "score");
      setAttempt(value => value + 1);
    } else active.session.selectMode(mode);
  }, setDefaultMode: (mode: "pdf" | "images" | null) => active?.session.setDefaultMode(mode), resetMode: () => active?.session.resetMode(), retry: () => setAttempt(value => value + 1), cancel: () => active?.session.cancel(), snapshot: active?.snapshot ?? initial, download: () => active?.session.download(), retryLayers: () => active?.session.retryLayers() };
}
