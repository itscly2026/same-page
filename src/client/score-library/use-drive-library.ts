import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { DriveLibrary } from "./drive-library";
import { type DriveCacheOwnerKey } from "./drive-library-cache";
import { driveLibraryTransport } from "./drive-library-transport";

export function useDriveLibrary(ownerKey: DriveCacheOwnerKey, choirId: string, signedIn: boolean) {
  const library = useMemo(() => new DriveLibrary(
    ownerKey, choirId, driveLibraryTransport(choirId, signedIn),
  ), [ownerKey, choirId, signedIn]);
  const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);

  useEffect(() => {
    library.start();
    const refresh = () => {
      if (document.visibilityState === "visible" && library.getSnapshot().access.kind === "opened") void library.refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      library.stop();
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [library]);

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
