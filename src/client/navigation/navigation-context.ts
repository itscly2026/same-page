import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
export type Exit = { kind: "overlay" | "editing"; leave: () => boolean | Promise<boolean> };
type Navigation = { register(exit: Exit): () => void; back(fallback: string): void; afterEditing(action: () => void): void };
export const Context = createContext<Navigation | null>(null);

export function useExitLayer(active: boolean, kind: Exit["kind"], leave: Exit["leave"]) {
  const navigation = useContext(Context);
  const latest = useRef(leave);
  useLayoutEffect(() => { latest.current = leave; });
  const register = navigation?.register;
  useLayoutEffect(() => {
    if (active && register) return register({ kind, leave: () => latest.current() });
  }, [active, kind, register]);
}

export function useAppNavigation() {
  const context = useContext(Context);
  const navigate = useNavigate();
  return context ?? { back: (fallback: string) => { void navigate(fallback, { replace: true }); }, afterEditing: (action: () => void) => action() };
}
