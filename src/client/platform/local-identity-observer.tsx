import { useEffect, useRef, useState } from "react";

import { OutboxRecoveryCoordinator } from "../annotations/outbox-recovery-coordinator";
import { useApplicationIdentity } from "../auth/application-identity";
import {
  activateAuthenticatedLocalOwner,
  type LocalWorkspaceOwnerKey,
} from "./local-workspace";
import { notifyReaderIdentityChange } from "../reader/reader-cache-events";
import { clearDiagnostics } from "../diagnostics/diagnostics";

export function LocalIdentityObserver() {
  const identity = useApplicationIdentity();
  const userId = identity.authenticatedUserId ?? undefined;
  const readerIdentity = useRef(identity.localUserId);
  const [identityState, setIdentityState] = useState<{
    observedUserId: string | undefined;
    activation: number;
    recoveryOwner: LocalWorkspaceOwnerKey | null;
  }>({ observedUserId: userId, activation: 0, recoveryOwner: null });

  useEffect(() => {
    const controller = new AbortController();
    if (!userId) return;
    const activation = identityState.activation;
    void activateAuthenticatedLocalOwner(userId, controller.signal).then((ownerKey) => {
      if (controller.signal.aborted) return;
      setIdentityState((current) =>
        current.observedUserId === userId &&
        current.activation === activation
          ? { ...current, recoveryOwner: ownerKey }
          : current,
      );
    }).catch(() => { /* Local storage failure must not turn a valid online session into a logout. */ });
    return () => controller.abort();
  }, [identityState.activation, userId]);

  useEffect(() => {
    if (readerIdentity.current === identity.localUserId) return;
    readerIdentity.current = identity.localUserId;
    clearDiagnostics();
    notifyReaderIdentityChange();
  }, [identity.localUserId]);

  if (identityState.observedUserId !== userId) {
    setIdentityState({
      observedUserId: userId,
      activation: identityState.activation + 1,
      recoveryOwner: null,
    });
    return null;
  }

  return userId && identityState.recoveryOwner ? (
    <OutboxRecoveryCoordinator
      key={identityState.activation}
      ownerKey={identityState.recoveryOwner}
    />
  ) : null;
}
