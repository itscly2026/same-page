import { useEffect, useRef } from "react";
import { revokeOfflinePreparationIdentity } from "../offline/offline-score";
import { readLogoutFence } from "./logout-fence";
import { useLiveQuery } from "dexie-react-hooks";
import { authClient } from "./auth-client";
import { currentLocalOwnerKey } from "../platform/local-workspace";

export type OnlineIdentityState = "checking" | "authenticated" | "signed-out" | "unreachable";

// Local ownership is a navigation/editing boundary, never proof of a cloud session.
export function useApplicationIdentity() {
  const remoteSession = authClient.useSession();
  const fence = useLiveQuery(readLogoutFence);
  const blocked = fence && fence.userId === remoteSession.data?.user.id;
  const session = blocked && !fence!.pending ? { ...remoteSession, data: null } : remoteSession;
  const rememberedOwner = useLiveQuery(() => currentLocalOwnerKey().catch(() => null));
  const onlineState: OnlineIdentityState = session.isPending ? "checking"
    : session.error ? (session.error.status === 401 ? "signed-out" : "unreachable") : session.data?.user ? "authenticated" : "signed-out";
  const confirmedUserId = !blocked && onlineState === "authenticated" ? session.data!.user.id : null;
  const sessionId = session.data?.session.id;
  const previousIdentity = useRef({ userId: confirmedUserId, sessionId });
  useEffect(() => {
    if (previousIdentity.current.userId && (previousIdentity.current.userId !== confirmedUserId || previousIdentity.current.sessionId !== sessionId)) revokeOfflinePreparationIdentity(previousIdentity.current.userId);
    previousIdentity.current = { userId: confirmedUserId, sessionId };
  }, [confirmedUserId, sessionId]);
  const localUserId = session.data?.user.id ?? (rememberedOwner?.startsWith("user:") ? rememberedOwner.slice(5) : null);
  return {
    session, onlineState, localUserId,
    authenticatedUserId: confirmedUserId,
    restoring: !session.data?.user && rememberedOwner === undefined,
    showLocalEntry: onlineState !== "authenticated" && (Boolean(localUserId) || rememberedOwner === undefined || onlineState !== "signed-out"),
  };
}
export type ApplicationIdentity = ReturnType<typeof useApplicationIdentity>;
