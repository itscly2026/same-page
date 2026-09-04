import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { diagnosticFetch } from "../diagnostics/diagnostics";

export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
  fetchOptions: { customFetchImpl: diagnosticFetch },
});
