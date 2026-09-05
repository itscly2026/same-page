import { useEffect, useRef, useState } from "react";
import type { LocalWorkspace } from "../platform/local-workspace";
import { saveDraftWithHistory, updateLatestHistoryDraft, type DraftInput } from "./annotation-state";

// Keep unwritten intent in the mounted editor until IndexedDB confirms it.
// This is only the write boundary; durable drafts and sync stay in annotation-state.
export function useDraftWriter(workspace: LocalWorkspace) {
  const pending = useRef(new Map<string, DraftInput>());
  const inFlight = useRef(0);
  const tail = useRef(Promise.resolve());
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const persist = (input: DraftInput, replaceHistory = false): Promise<boolean> => {
    inFlight.current++;
    pending.current.set(input.id, input);
    setState("saving");
    const operation = tail.current.then(async () => {
      try {
        await (replaceHistory ? updateLatestHistoryDraft : saveDraftWithHistory)(workspace, input);
        if (pending.current.get(input.id) === input) pending.current.delete(input.id);
        return true;
      } catch { return false; }
    });
    tail.current = operation.then(() => {
      inFlight.current--;
      setState(inFlight.current ? "saving" : pending.current.size ? "failed" : "idle");
    });
    return operation;
  };
  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (!pending.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);
  return { state, persist, retry: () => Promise.all([...pending.current.values()].map(input => persist(input))) };
}
