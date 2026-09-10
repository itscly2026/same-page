import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { sharedDriveLibrary, retainDriveLibrary } from "./shared-drive-library";
import { type DriveCacheOwnerKey } from "./drive-library-cache";

export function useDriveLibraryResource(ownerKey: DriveCacheOwnerKey, choirId: string, signedIn: boolean, identityReady: boolean, sessionId: string | null = null) {
  const library = sharedDriveLibrary(ownerKey, choirId, sessionId);
  const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);

  useEffect(() => library.setAuthenticated(signedIn), [library, signedIn]);

  useEffect(() => {
    if (!identityReady) return;
    const release = retainDriveLibrary(library);
    const refresh = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void library.refreshIfStale();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      release();
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [library, identityReady, signedIn]);

  return { library, snapshot };
}

export function useDriveLibrary(ownerKey: DriveCacheOwnerKey, choirId: string, signedIn: boolean, identityReady: boolean, sessionId: string | null = null) {
  const { library, snapshot } = useDriveLibraryResource(ownerKey, choirId, signedIn, identityReady, sessionId);

  // Detach before the next route resets scroll in its layout effects. Keep
  // network startup passive so identity observers clear the previous owner first.
  useLayoutEffect(() => {
    const save = () => library.rememberScroll(window.scrollY);
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("scroll", save);
      window.removeEventListener("pagehide", save);
    };
  }, [library]);

  useEffect(() => {
    if (snapshot.access.kind !== "opened") return;
    const frame = window.requestAnimationFrame(() => library.restoreScroll(scrollTop => {
      document.documentElement.scrollTop = scrollTop;
      document.body.scrollTop = scrollTop;
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [library, snapshot.access.kind]);

  return { library, snapshot };
}
