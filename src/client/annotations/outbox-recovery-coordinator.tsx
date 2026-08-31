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
      running = true;
      void recoverAnnotationOutbox(ownerKey, trigger).finally(() => {
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
