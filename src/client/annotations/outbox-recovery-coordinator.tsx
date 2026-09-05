import { useEffect } from "react";

import type { LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import {
  OUTBOX_RECOVERY_REQUEST_EVENT,
  recoverAnnotationOutbox,
  type OutboxRecoveryTrigger,
} from "./outbox-recovery";

export function OutboxRecoveryCoordinator({
  ownerKey,
}: {
  ownerKey: LocalWorkspaceOwnerKey;
}) {
  useEffect(() => {
    let disposed = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingTrigger: OutboxRecoveryTrigger | null = null;

    const schedule = (trigger: OutboxRecoveryTrigger) => {
      if (
        disposed ||
        !navigator.onLine ||
        globalThis.document.visibilityState === "hidden"
      ) {
        return;
      }
      if (running) {
        pendingTrigger = trigger;
        return;
      }
      clearTimeout(timer);
      running = true;
      void recoverAnnotationOutbox(ownerKey, trigger).then((summary) => {
        if (!disposed && summary.remainingOperations > 0 && summary.nextAttemptAt) {
          timer = setTimeout(() => schedule("foreground"), Math.max(1_000, summary.nextAttemptAt - Date.now()));
        }
      }).finally(() => {
        running = false;
        if (disposed || !pendingTrigger) return;
        const nextTrigger = pendingTrigger;
        pendingTrigger = null;
        schedule(nextTrigger);
      });
    };
    const onOnline = () => schedule("online");
    const onVisibilityChange = () => schedule("foreground");
    const onManualRequest = () => schedule("manual");

    schedule("startup");
    window.addEventListener("online", onOnline);
    window.addEventListener(OUTBOX_RECOVERY_REQUEST_EVENT, onManualRequest);
    globalThis.document.addEventListener(
      "visibilitychange",
      onVisibilityChange,
    );
    return () => {
      disposed = true;
      clearTimeout(timer);
      pendingTrigger = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener(
        OUTBOX_RECOVERY_REQUEST_EVENT,
        onManualRequest,
      );
      globalThis.document.removeEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
    };
  }, [ownerKey]);

  return null;
}
