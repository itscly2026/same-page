import { useEffect, useRef, useState } from "react";

export function useReaderFullscreen() {
  const [active, setActive] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  const owned = useRef(false);
  const busy = useRef(false);
  const supported = typeof document.documentElement.requestFullscreen === "function" && document.fullscreenEnabled;

  useEffect(() => {
    mounted.current = true;
    const update = () => {
      const fullscreen = document.fullscreenElement === document.documentElement;
      setActive(fullscreen);
      if (!fullscreen) owned.current = false;
    };
    update();
    document.addEventListener("fullscreenchange", update);
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", update);
      if (owned.current && document.fullscreenElement === document.documentElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  const toggle = async () => {
    if (busy.current) return;
    if (!supported) {
      setMessage("当前浏览器不支持系统全屏，可以继续阅读。已安装应用的显示方式由设备系统决定。");
      return;
    }
    busy.current = true;
    setPending(true);
    setMessage(null);
    try {
      if (document.fullscreenElement === document.documentElement) {
        await document.exitFullscreen();
      } else {
        // Fullscreen the document so portalled menus and editors remain visible.
        // Call before any await: fullscreen requires the user's activation.
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
        owned.current = true;
        if (!mounted.current && document.fullscreenElement === document.documentElement) {
          await document.exitFullscreen();
        }
      }
    } catch {
      if (mounted.current) setMessage("系统未允许切换全屏，可以继续阅读或重试。");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return { active, pending, message, toggle };
}
