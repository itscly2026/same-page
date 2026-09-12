import { createContext, useContext } from "react";

export const InstallContext = createContext<{
  hidden: boolean;
  requested: boolean;
  nativeAvailable: boolean;
  suggest: boolean;
  open: () => void;
  dismiss: () => void;
} | null>(null);

export const useInstall = () => useContext(InstallContext);

export type InstallGuide = "safari" | "ios-chrome" | "ios-external" | "android" | "android-external" | "desktop";

export function isWeChat(userAgent: string) { return /MicroMessenger/i.test(userAgent); }

export function detectInstallGuide(userAgent: string, touchPoints: number): InstallGuide {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
  const embedded = /MicroMessenger|FBAN|FBAV|Instagram|; wv\)/i.test(userAgent);
  if (ios) return embedded ? "ios-external" : /CriOS/.test(userAgent) ? "ios-chrome" : "safari";
  if (/Android/.test(userAgent)) return embedded ? "android-external" : "android";
  return "desktop";
}

export function readInstallPreference(key: string) {
  try { return window.localStorage.getItem(key) === "yes"; } catch { return false; }
}

export function saveInstallPreference(key: string) {
  try { window.localStorage.setItem(key, "yes"); } catch { /* Installation help also works without storage. */ }
}
