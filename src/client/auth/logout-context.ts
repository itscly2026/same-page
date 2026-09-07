import { createContext, useContext } from "react";
export const LogoutContext = createContext<(() => Promise<void>) | null>(null);
export function useLogout() {
  const request = useContext(LogoutContext);
  return { request: request ?? (async () => { throw new Error("logout_provider_missing"); }) };
}
