import { useNetworkStatus } from "../platform/use-network-status";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { captureReadIdentity, getReadResource } from "./read-resource";

// Only explicitly selected, non-sensitive resources reuse a confirmation on
// remount. Other settings still read on every mount, sharing concurrent reads.
export function useReadResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, restore?: () => Promise<T | null>, staleTime = 0) {
  const online = useNetworkStatus();
  const resource = getReadResource<T>(key);
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  const loader = useRef(load);
  useEffect(() => { loader.current = load; }, [load]);
  const restoreLoader = useRef(restore);
  useEffect(() => { restoreLoader.current = restore; }, [restore]);
  useEffect(() => {
    let active = true;
    const currentIdentity = captureReadIdentity();
    void restoreLoader.current?.().then(data => {
      if (active && currentIdentity() && data) resource.restore(data);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [resource]);
  const refresh = useCallback(() => resource.read(signal => loader.current(signal)), [resource]);
  useEffect(() => {
    const refreshIfStale = () => { if (document.visibilityState === "visible" && navigator.onLine) void resource.read(signal => loader.current(signal), staleTime).catch(() => undefined); };
    void resource.read(signal => loader.current(signal), staleTime).catch(() => undefined);
    if (staleTime > 0) {
      window.addEventListener("focus", refreshIfStale);
      window.addEventListener("online", refreshIfStale);
    }
    // The resource owns its request; one departing consumer cannot cancel others.
    return () => { window.removeEventListener("focus", refreshIfStale); window.removeEventListener("online", refreshIfStale); };
  }, [resource, staleTime]);
  return { ...state, refresh, confirm: resource.confirm, update: resource.update, clear: resource.clear, loading: !state.data && state.request === "pending", canMutate: online && state.authority === "confirmed" && (staleTime > 0 || (state.request !== "pending" && !state.error)) };
}
