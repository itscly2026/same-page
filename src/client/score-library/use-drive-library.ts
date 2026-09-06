import { captureLocalWorkspaceSession, createLocalWorkspace, authenticatedLocalOwnerKey } from "../platform/local-workspace";
import { rememberLocalDriveDirectory } from "./local-drive-directory";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { DriveLibrary } from "./drive-library";
import { type DriveCacheOwnerKey } from "./drive-library-cache";
import { driveLibraryTransport } from "./drive-library-transport";

export function useDriveLibrary(ownerKey: DriveCacheOwnerKey, choirId: string, signedIn: boolean) {
  const library = useMemo(() => {
    const transport = driveLibraryTransport(choirId, signedIn);
    return new DriveLibrary(ownerKey, choirId, {
      ...transport,
      async load(signal, allowAdmission) {
        const workspace = signedIn && ownerKey.startsWith("user:")
          ? captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(ownerKey.slice(5)), choirId, "")).catch(() => null)
          : Promise.resolve(null);
        const access = await transport.load(signal, allowAdmission);
        const captured = await workspace;
        if (captured && access.kind === "opened") {
          await rememberLocalDriveDirectory(captured, access.choir, access.result.scores, signal).catch(() => undefined);
        }
        return access;
      },
    });
  }, [ownerKey, choirId, signedIn]);
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
