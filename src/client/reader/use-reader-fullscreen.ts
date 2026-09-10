import { useEffect, useRef, useState } from "react";

// Fullscreen the document so body portals (text input, menus, dialogs) remain
// visible. This reader only exits a fullscreen session it requested itself.
export function useReaderFullscreen() {
  const [active, setActive] = useState(!!document.fullscreenElement);
  const [error, setError] = useState<string | null>(null);
  const owned = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const update = () => {
      setActive(!!document.fullscreenElement);
      if (!document.fullscreenElement) owned.current = false;
    };
    document.addEventListener("fullscreenchange", update);
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", update);
      if (owned.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);
  const toggle = async () => {
    setError(null);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        owned.current = true;
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
        if (!mounted.current && document.fullscreenElement) await document.exitFullscreen();
      }
    } catch {
      owned.current = false;
      if (mounted.current) setError("暂时无法进入全屏，请重试。");
    }
  };
  return { active, supported: !!document.fullscreenEnabled, error, toggle };
}
