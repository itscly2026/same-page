import { liveQuery, type Subscription } from "dexie";
import { useEffect, useRef, useState } from "react";
import type { ApplicationIdentity } from "../auth/application-identity";
import { cleanupUncreatedDeleteConflicts } from "../annotations/annotation-state";
import { assertLocalWorkspaceActive, isLocalWorkspaceActive, LocalWorkspaceOwnerChangedError, captureLocalWorkspaceSession, resolveLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";

type WorkspaceState = { status: "opening" } | { status: "ready"; workspace: LocalWorkspace } | { status: "failed"; message: string };
interface Options {
  choirId: string;
  scoreId: string;
  experience: boolean;
  identity: Pick<ApplicationIdentity, "localUserId" | "restoring" | "onlineState">;
}

const timeoutMessage = "打开本机工作区用时较长，可以重试或返回云盘。";
const failureMessage = "本机工作区暂时无法打开，请重试；已保存的内容仍然保留。";

export function useReaderWorkspace({ choirId, scoreId, experience, identity }: Options) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([choirId, scoreId, experience, identity.localUserId, attempt]);
  const [result, setResult] = useState<{ key: string; state: WorkspaceState }>();
  const failedKey = useRef<string | null>(null);
  const waiting = identity.restoring || (!identity.localUserId && identity.onlineState === "checking");
  useEffect(() => {
    if (failedKey.current === key) return;
    failedKey.current = null;
    const lifetime = new AbortController();
    let preparation = new AbortController();
    let subscription: Subscription | undefined;
    let phase: "opening" | "ready" = "opening";
    const publish = (state: WorkspaceState) => setResult({ key, state });
    const stop = () => {
      lifetime.abort();
      preparation.abort();
      subscription?.unsubscribe();
      clearTimeout(timer);
    };
    const fail = (message: string) => {
      if (lifetime.signal.aborted) return;
      failedKey.current = key;
      stop();
      publish({ status: "failed", message });
    };
    let timer = setTimeout(() => fail(timeoutMessage), 45_000);
    const restartDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(timeoutMessage), 45_000);
    };
    const prepare = async (resolved?: LocalWorkspace) => {
      preparation.abort();
      const controller = preparation = new AbortController();
      subscription?.unsubscribe();
      const current = () => !lifetime.signal.aborted && !controller.signal.aborted;
      phase = "opening";
      publish({ status: "opening" });
      restartDeadline();
      const observe = (base: LocalWorkspace, workspace?: LocalWorkspace) => {
        let invalidated = false;
        subscription = liveQuery(async () => {
          if (!workspace) return await isLocalWorkspaceActive(base) ? "recapture" as const : "revoked" as const;
          try {
            await assertLocalWorkspaceActive(workspace);
            return "valid" as const;
          } catch (error) {
            if (!(error instanceof LocalWorkspaceOwnerChangedError)) throw error;
            return await isLocalWorkspaceActive(base) ? "recapture" as const : "revoked" as const;
          }
        }).subscribe({
          next: validity => {
            if (!current()) return;
            if (validity === "valid" && workspace && !invalidated) {
              clearTimeout(timer);
              phase = "ready";
              publish({ status: "ready", workspace });
            } else {
              invalidated = true;
              if (phase === "ready") {
                phase = "opening";
                publish({ status: "opening" });
                restartDeadline();
              }
              if (validity !== "revoked") void prepare(base);
            }
          },
          error: () => { if (current()) fail(failureMessage); },
        });
      };
      let base = resolved;
      try {
        // Only the initial attempt resolves ownership. Epoch recovery must not
        // activate an owner that another login/logout has already revoked.
        base = resolved ?? await resolveLocalWorkspace({ choirId, scoreId, experience,
          authenticatedUserId: identity.localUserId, signal: controller.signal });
        if (!current()) return;
        const workspace = await captureLocalWorkspaceSession(base);
        if (!current()) return;
        await cleanupUncreatedDeleteConflicts(workspace).catch(() => {
          // Historical cleanup failure is tolerated; a stall still has a deadline.
        });
        if (!current()) return;
        observe(base, workspace);
      } catch (error) {
        if (!current()) return;
        if (error instanceof LocalWorkspaceOwnerChangedError && base) {
          // Ownership can disappear between observing an epoch and capturing it.
          // Keep waiting without reactivating that owner or publishing a bare scope.
          observe(base);
        } else fail(failureMessage);
      }
    };
    publish({ status: "opening" });
    if (!waiting) void prepare();
    return stop;
  }, [key, choirId, scoreId, experience, identity.localUserId, waiting]);
  const state: WorkspaceState = result?.key === key ? result.state : { status: "opening" };
  return { state, retry: () => setAttempt(value => value + 1) };
}
