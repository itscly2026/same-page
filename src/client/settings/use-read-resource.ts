import { useCallback, useEffect, useRef, useState } from "react";
import { captureReadIdentity, failedRead, forgetResource, readResource, rememberResource, type ReadState } from "./read-resource";

// Keys include user, drive and view. Cached data is presentation only; every
// mounted consumer confirms authority independently before protected mutations.
export function useReadResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, restore?: () => Promise<T | null>) {
  const [state, setState] = useState<ReadState<T>>(() => ({ data: readResource<T>(key), request: "pending", authority: "unconfirmed", error: null }));
  const [currentKey, setCurrentKey] = useState(key);
  if (currentKey !== key) {
    setCurrentKey(key);
    setState({ data: readResource<T>(key), request: "pending", authority: "unconfirmed", error: null });
  }
  const loader = useRef(load);
  useEffect(() => { loader.current = load; }, [load]);
  const restoreLoader = useRef(restore);
  useEffect(() => { restoreLoader.current = restore; }, [restore]);
  useEffect(() => {
    let active = true;
    const currentIdentity = captureReadIdentity();
    void restoreLoader.current?.().then(data => {
      if (active && currentIdentity() && data) setState(previous => !previous.data && previous.authority === "unconfirmed" ? { ...previous, data } : previous);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [key]);
  const activeRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    const currentIdentity = captureReadIdentity();
    const current = () => !controller.signal.aborted && currentIdentity();
    setState(previous => ({ ...previous, request: "pending", error: null }));
    try {
      const data = await loader.current(controller.signal);
      if (!current()) return;
      rememberResource(key, data);
      setState({ data, request: "idle", authority: "confirmed", error: null });
    } catch (error) {
      if (!current()) return;
      setState(previous => {
        const next = failedRead(previous, error);
        if (!next.data) forgetResource(key);
        return next;
      });
      throw error;
    }
  }, [key]);
  useEffect(() => { void refresh().catch(() => undefined); return () => activeRequest.current?.abort(); }, [refresh]);
  const confirm = (data: T) => {
    activeRequest.current?.abort(); rememberResource(key, data);
    setState({ data, request: "idle", authority: "confirmed", error: null });
  };
  const clear = () => { activeRequest.current?.abort(); forgetResource(key); setState({ data: null, request: "idle", authority: "revoked", error: null }); };
  return { ...state, refresh, confirm, clear, loading: !state.data && state.request === "pending", canMutate: state.authority === "confirmed" && state.request !== "pending" };
}
