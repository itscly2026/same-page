import { useContext } from "react";
import { Dialog as AriaDialog, OverlayTriggerStateContext, type DialogProps, Menu as AriaMenu, type MenuProps } from "react-aria-components";
import { useExitLayer } from "./navigation-context";

// Every mounted dialog participates, including dialogs opened by DialogTrigger.
export function Dialog({ exitDisabled = false, preserveOnNavigate = false, ...props }: DialogProps & { exitDisabled?: boolean; preserveOnNavigate?: boolean }) {
  const state = useContext(OverlayTriggerStateContext);
  useExitLayer(Boolean(state?.isOpen), "overlay", destination => { if (destination && preserveOnNavigate) return true; if (exitDisabled) return false; state?.close(); return true; });
  return <AriaDialog {...props} />;
}

export function Menu<T extends object>(props: MenuProps<T>) {
  const state = useContext(OverlayTriggerStateContext);
  useExitLayer(Boolean(state?.isOpen), "overlay", () => { state?.close(); return true; });
  return <AriaMenu {...props} />;
}
