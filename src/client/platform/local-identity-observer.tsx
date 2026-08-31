import { useEffect } from "react";

import { authClient } from "../auth/auth-client";
import { activateAuthenticatedLocalOwner } from "./local-workspace";

export function LocalIdentityObserver() {
  const session = authClient.useSession();

  useEffect(() => {
    const userId = session.data?.user.id;
    if (!userId) return;
    void activateAuthenticatedLocalOwner(userId);
  }, [session.data?.user.id]);

  return null;
}
