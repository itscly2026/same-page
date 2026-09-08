import { useEffect, useRef, type RefObject } from "react";
import { useVisitStorage } from "./navigation-context";

// Preserve a viewport only within this visit. New route entries and reloads
// use the layout's normal fit/position rules.
export function useReturnViewport(ref: RefObject<HTMLElement | null>, name: string, ready: boolean) {
  const { store, key } = useVisitStorage(`viewport:${name}`);
  const restored = useRef(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !ready) return;
    let cleanupRestore = () => {};
    if (!restored.current) {
      const saved = store?.get(key) as { left: number; top: number; href?: string } | undefined;
      if (saved) {
        const restore = () => {
          if (!element.isConnected) return;
          const link = Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]")).find(link => link.getAttribute("href") === saved.href);
          if (saved.href && !link) return;
          restored.current = true;
          link?.focus({ preventScroll: true });
          element.scrollLeft = saved.left; element.scrollTop = saved.top;
          observer.disconnect();
        };
        const observer = new MutationObserver(restore);
        observer.observe(element, { childList: true, subtree: true });
        const frame = requestAnimationFrame(restore);
        cleanupRestore = () => { observer.disconnect(); cancelAnimationFrame(frame); };
      }
    }

    const capture = (event: Event) => {
      const focused = event.type === "click" && event.target instanceof Element ? event.target.closest("a[href]") : element.ownerDocument.activeElement;
      store?.set(key, { left: element.scrollLeft, top: element.scrollTop,
        href: focused instanceof HTMLAnchorElement && element.contains(focused) ? focused.getAttribute("href") : undefined });
    };
    element.addEventListener("scroll", capture, { passive: true });
    element.addEventListener("click", capture, true);
    return () => { cleanupRestore(); element.removeEventListener("scroll", capture); element.removeEventListener("click", capture, true); };
  }, [key, store, ready, ref]);
}
