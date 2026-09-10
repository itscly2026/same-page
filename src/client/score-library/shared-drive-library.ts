import { onReaderIdentityChange } from "../reader/reader-cache-events";
import { onNavigationReset } from "../settings/navigation-events";
import { DriveLibrary } from "./drive-library";
import type { DriveCacheOwnerKey } from "./drive-library-cache";

const libraries = new Map<string, { library: DriveLibrary; users: number }>();
const keys = new WeakMap<DriveLibrary, string>();
function clear() { for (const entry of libraries.values()) entry.library.stop(); libraries.clear(); }
onReaderIdentityChange(clear);
onNavigationReset(clear);
export function sharedDriveLibrary(owner: DriveCacheOwnerKey, driveId: string, sessionId: string | null) {
  const key = JSON.stringify([owner, driveId, sessionId]);
  let entry = libraries.get(key);
  if (!entry) {
    entry = { library: new DriveLibrary(owner, driveId), users: 0 };
    libraries.set(key, entry);
    keys.set(entry.library, key);
    for (const [oldKey, old] of libraries) if (libraries.size > 6 && oldKey !== key && old.users === 0) { old.library.stop(); libraries.delete(oldKey); }
  }
  return entry.library;
}
export function retainDriveLibrary(library: DriveLibrary) {
  let entry = [...libraries.values()].find(entry => entry.library === library);
  if (!entry) {
    // A layout-phase identity reset may run after render, before this mount.
    entry = { library, users: 0 };
    libraries.set(keys.get(library)!, entry);
  }
  entry.users++;
  library.start();
  const retained = entry;
  return () => {
    if (--retained.users === 0) void library.whenSettled().finally(() => {
      if (retained.users === 0) library.stop();
    });
  };
}
