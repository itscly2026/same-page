import { createContext, useContext, useLayoutEffect, useRef, useState, useCallback, type SetStateAction } from "react";
import { useNavigate, useLocation } from "react-router-dom";
export type Exit = { kind: "overlay" | "editing" | "form"; leave: (destination?: boolean) => boolean | "cancelled" | Promise<boolean | "cancelled"> };
type Navigation = { returnState: Map<string, unknown>; register(exit: Exit): () => void; back(fallback: string): void; afterEditing(action: () => void): void };
export const Context = createContext<Navigation | null>(null);

export function useExitLayer(active: boolean, kind: Exit["kind"], leave: Exit["leave"]) {
  const navigation = useContext(Context);
  const latest = useRef(leave);
  useLayoutEffect(() => { latest.current = leave; });
  const register = navigation?.register;
  useLayoutEffect(() => {
    if (active && register) return register({ kind, leave: destination => latest.current(destination) });
  }, [active, kind, register]);
}

export function useAppNavigation() {
  const context = useContext(Context);
  const navigate = useNavigate();
  return context ?? { back: (fallback: string) => { void navigate(fallback, { replace: true }); }, afterEditing: (action: () => void) => action() };
}

export function useVisitStorage(name: string) {
  const store = useContext(Context)?.returnState;
  const location = useLocation();
  return { store, key: `${location.state?.exitCheckpoint ?? location.key}:${location.pathname}:${name}` };
}

// Kept only for this document lifetime and attached to one history entry.
// Reloads and new visits never inherit an old drawer or reader panel.
export function useReturnState<T>(name: string, initial: T) {
  const { store, key } = useVisitStorage(name);
  const [value, update] = useState<T>(() => store?.has(key) ? store.get(key) as T : initial);
  const current = useRef(value);
  useLayoutEffect(() => { store?.set(key, current.current); }, [store, key]);
  const setValue = useCallback((next: SetStateAction<T>) => {
    const resolved = typeof next === "function" ? (next as (old: T) => T)(current.current) : next;
    current.current = resolved;
    store?.set(key, resolved);
    update(resolved);
  }, [store, key]);
  return [value, setValue] as const;
}
