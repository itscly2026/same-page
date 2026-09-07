import { useContext } from "react";
import { Dialog as AriaDialog, OverlayTriggerStateContext, type DialogProps, Menu as AriaMenu, type MenuProps } from "react-aria-components";
import { useExitLayer } from "./navigation-context";

// Every mounted dialog participates, including dialogs opened by DialogTrigger.
export function Dialog({ exitDisabled = false, ...props }: DialogProps & { exitDisabled?: boolean }) {
  const state = useContext(OverlayTriggerStateContext);
  useExitLayer(Boolean(state?.isOpen), "overlay", () => { if (exitDisabled) return false; state?.close(); return true; });
  return <AriaDialog {...props} />;
}

export function Menu<T extends object>(props: MenuProps<T>) {
  const state = useContext(OverlayTriggerStateContext);
  useExitLayer(Boolean(state?.isOpen), "overlay", () => { state?.close(); return true; });
  return <AriaMenu {...props} />;
}
