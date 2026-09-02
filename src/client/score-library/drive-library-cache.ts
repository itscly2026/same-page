import type { ChoirSummary } from "../../shared/choirs";
import type { ScoreListResponse } from "../../shared/scores";
import { onReaderIdentityChange } from "../reader/reader-cache-events";

export type DriveCacheOwnerKey = `user:${string}` | `guest:${string}`;

export interface DriveLibrarySnapshot {
  choir: ChoirSummary | null;
  result: ScoreListResponse;
  search: string;
  scrollTop: number;
  updatedAt: number;
}

const MAX_DRIVES = 6;
const libraries = new Map<string, DriveLibrarySnapshot>();
let activeOwner: DriveCacheOwnerKey | null = null;

onReaderIdentityChange(clearDriveLibraryCache);

export function driveCacheOwnerKey(
  authenticatedUserId: string | null,
  choirId: string,
): DriveCacheOwnerKey {
  return authenticatedUserId
    ? `user:${authenticatedUserId}`
    : `guest:${choirId}`;
}

export function readDriveLibrary(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
): DriveLibrarySnapshot | null {
  activateOwner(ownerKey);
  const cached = libraries.get(choirId);
  if (!cached) return null;
  libraries.delete(choirId);
  libraries.set(choirId, cached);
  return { ...cached };
}

export function rememberDriveLibrary(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
  library: Pick<DriveLibrarySnapshot, "choir" | "result">,
) {
  activateOwner(ownerKey);
  const previous = libraries.get(choirId);
  libraries.delete(choirId);
  libraries.set(choirId, {
    ...library,
    search: previous?.search ?? "",
    scrollTop: previous?.scrollTop ?? 0,
    updatedAt: Date.now(),
  });
  evictOverflow();
}

export function rememberDriveView(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
  view: Pick<DriveLibrarySnapshot, "search" | "scrollTop">,
) {
  activateOwner(ownerKey);
  const previous = libraries.get(choirId);
  if (!previous) return;
  libraries.set(choirId, { ...previous, ...view });
}

export function invalidateDriveLibrary(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
) {
  activateOwner(ownerKey);
  libraries.delete(choirId);
}

export function clearDriveLibraryCache() {
  libraries.clear();
  activeOwner = null;
}

function activateOwner(ownerKey: DriveCacheOwnerKey) {
  if (activeOwner === ownerKey) return;
  libraries.clear();
  activeOwner = ownerKey;
}

function evictOverflow() {
  while (libraries.size > MAX_DRIVES) {
    const oldest = libraries.keys().next().value;
    if (oldest === undefined) return;
    libraries.delete(oldest);
  }
}
