import { createSessionFetch } from "./session-fetch";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { diagnosticFetch } from "../diagnostics/diagnostics";

export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
  sessionOptions: { refetchWhenOffline: true, refetchOnWindowFocus: false },
  fetchOptions: { customFetchImpl: createSessionFetch(diagnosticFetch) },
});
