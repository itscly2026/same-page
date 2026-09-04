import { useEffect, useRef, useState } from "react";

import { OutboxRecoveryCoordinator } from "../annotations/outbox-recovery-coordinator";
import { authClient } from "../auth/auth-client";
import {
  activateAuthenticatedLocalOwner,
  type LocalWorkspaceOwnerKey,
} from "./local-workspace";
import { notifyReaderIdentityChange } from "../reader/reader-cache-events";
import { clearDiagnostics } from "../diagnostics/diagnostics";

export function LocalIdentityObserver() {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const readerIdentity = useRef(userId);
  const [identityState, setIdentityState] = useState<{
    observedUserId: string | undefined;
    activation: number;
    recoveryOwner: LocalWorkspaceOwnerKey | null;
  }>({ observedUserId: userId, activation: 0, recoveryOwner: null });

  useEffect(() => {
    let active = true;
    if (!userId) return;
    const activation = identityState.activation;
    void activateAuthenticatedLocalOwner(userId).then((ownerKey) => {
      if (!active) return;
      setIdentityState((current) =>
        current.observedUserId === userId &&
        current.activation === activation
          ? { ...current, recoveryOwner: ownerKey }
          : current,
      );
    });
    return () => {
      active = false;
    };
  }, [identityState.activation, userId]);

  useEffect(() => {
    if (readerIdentity.current === userId) return;
    readerIdentity.current = userId;
    clearDiagnostics();
    notifyReaderIdentityChange();
  }, [userId]);

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
