import { noCapabilities, hasManagement } from "../../shared/drive-permissions";
import { captureLocalWorkspaceSession, createLocalWorkspace, authenticatedLocalOwnerKey } from "../platform/local-workspace";
import { readLocalDriveDirectories, rememberLocalDriveDirectory, renameLocalDriveDirectory } from "./local-drive-directory";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { DriveLibrary } from "./drive-library";
import { readDriveSummary, type DriveCacheOwnerKey } from "./drive-library-cache";
import { driveLibraryTransport } from "./drive-library-transport";

export function useDriveLibrary(ownerKey: DriveCacheOwnerKey, choirId: string, signedIn: boolean, identityReady: boolean) {
  const library = useMemo(() => {
    const transport = driveLibraryTransport(choirId, signedIn);
    const readLocal = async (signal: AbortSignal) => {
      if (!ownerKey.startsWith("user:")) return null;
      const directory = (await readLocalDriveDirectories(ownerKey.slice(5))).find(entry => entry.choirId === choirId);
      signal.throwIfAborted();
      return { kind: "opened" as const, local: true, isMember: false, rememberedMembership: directory?.membership ?? false, managementVisible: hasManagement(directory?.capabilities ?? noCapabilities()), rememberedCapabilities: directory?.capabilities,
        choir: directory?.choir ?? readDriveSummary(ownerKey, choirId) ?? { id: choirId, name: "云盘", guestAdmissionMode: "invite" as const },
        result: { scores: directory?.scores ?? [], storage: directory?.storage ?? { usedBytes: 0, limitBytes: 1 }, permissions: { capabilities: noCapabilities() } } };
    };
    return new DriveLibrary(ownerKey, choirId, {
      ...transport,
      readLocal,
      async rememberName(name, signal) {
        if (!ownerKey.startsWith("user:")) return;
        const workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(ownerKey.slice(5)), choirId, ""));
        await renameLocalDriveDirectory(workspace, name, signal);
      },
      async load(signal, allowAdmission) {
        if (!signedIn && ownerKey.startsWith("user:")) return (await readLocal(signal))!;
        const workspace = signedIn && ownerKey.startsWith("user:")
          ? captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(ownerKey.slice(5)), choirId, "")).catch(() => null)
          : Promise.resolve(null);
        const access = await transport.load(signal, allowAdmission);
        const captured = await workspace;
        if (captured && access.kind === "opened") {
          await rememberLocalDriveDirectory(captured, access.choir, access.result.scores, signal, access.isMember && !access.choir.isPreviewEntry, access.result.permissions.capabilities, access.result.storage).catch(() => undefined);
        }
        return access;
      },
    });
  }, [ownerKey, choirId, signedIn]);
  const snapshot = useSyncExternalStore(library.subscribe, library.getSnapshot);

  useEffect(() => {
    if (!identityReady) return;
    library.start();
    const refresh = () => {
      if (document.visibilityState === "visible") void library.refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      library.stop();
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [library, identityReady]);

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
