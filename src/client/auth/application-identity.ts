import { localDatabase } from "../platform/local-database";
import { useLiveQuery } from "dexie-react-hooks";
import { authClient } from "./auth-client";
import { currentLocalOwnerKey } from "../platform/local-workspace";

export type OnlineIdentityState = "checking" | "authenticated" | "signed-out" | "unreachable";

// Local ownership is a navigation/editing boundary, never proof of a cloud session.
export function useApplicationIdentity() {
  const remoteSession = authClient.useSession();
  const fence = useLiveQuery(() => localDatabase.system.get("auth:explicit-logout"));
  const blocked = fence?.value && JSON.parse(fence.value).userId === remoteSession.data?.user.id;
  const session = blocked && !JSON.parse(fence!.value).pending ? { ...remoteSession, data: null } : remoteSession;
  const rememberedOwner = useLiveQuery(() => currentLocalOwnerKey().catch(() => null));
  const onlineState: OnlineIdentityState = session.isPending ? "checking"
    : session.error ? (session.error.status === 401 ? "signed-out" : "unreachable") : session.data?.user ? "authenticated" : "signed-out";
  const localUserId = session.data?.user.id ?? (rememberedOwner?.startsWith("user:") ? rememberedOwner.slice(5) : null);
  return {
    session, onlineState, localUserId,
    authenticatedUserId: !blocked && onlineState === "authenticated" ? session.data!.user.id : null,
    restoring: !session.data?.user && rememberedOwner === undefined,
    showLocalEntry: onlineState !== "authenticated" && (Boolean(localUserId) || rememberedOwner === undefined || onlineState !== "signed-out"),
  };
}
export type ApplicationIdentity = ReturnType<typeof useApplicationIdentity>;
