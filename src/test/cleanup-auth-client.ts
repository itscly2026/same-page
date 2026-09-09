import { cleanup } from "@testing-library/react";
import { cleanStores } from "nanostores";
import { authClient } from "../client/auth/auth-client";

export function cleanupAuthClient() {
  cleanup();
  // Nano Stores defers unmount cleanup by one second. Finish it while jsdom
  // still exists so Better Auth can remove its browser event listeners.
  cleanStores(authClient.$store.atoms.session);
}
