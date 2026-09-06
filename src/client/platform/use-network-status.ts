import { useSyncExternalStore } from "react";
const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => { window.removeEventListener("online", notify); window.removeEventListener("offline", notify); };
};
// A hint only: server responses still decide authentication and authorization.
export const useNetworkStatus = () => useSyncExternalStore(subscribe, () => navigator.onLine);
