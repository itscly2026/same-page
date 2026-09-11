import { useEffect, useRef } from "react";

/** Keep the current auth input visible when a mobile keyboard returns with the app. */
export function useAuthInputVisibility() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const viewport = window.visualViewport;
    let frame: number | undefined;

    const ensureVisible = () => {
      frame = undefined;
      if (document.visibilityState !== "visible") return;
      const input = document.activeElement;
      if (!(input instanceof HTMLInputElement) || !container.contains(input) || input.disabled) return;
      const bounds = input.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      if (height <= 0 || bounds.height <= 0) return;
      // Layout coordinates include the browser's visual viewport pan. Restoring
      // focus after app switching does not necessarily restore that pan.
      if (bounds.top < top || bounds.bottom > top + height) {
        input.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      }
    };
    const schedule = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(ensureVisible);
    };

    container.addEventListener("focusin", schedule);
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("pageshow", schedule);
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      container.removeEventListener("focusin", schedule);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("pageshow", schedule);
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
    };
  }, []);

  return containerRef;
}
