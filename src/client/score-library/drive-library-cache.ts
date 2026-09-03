import type { ChoirSummary } from "../../shared/choirs";
import type { ScoreListResponse } from "../../shared/scores";
import { onReaderIdentityChange } from "../reader/reader-cache-events";

export type DriveCacheOwnerKey = `user:${string}` | `guest:${string}`;

export interface DriveLibrarySnapshot {
  choir: ChoirSummary;
  result: ScoreListResponse;
  search: string;
  scrollTop: number;
  updatedAt: number;
}

const MAX_DRIVES = 6;
const libraries = new Map<string, DriveLibrarySnapshot>();
const summaries = new Map<string, ChoirSummary>();
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
  rememberSummary(choirId, library.choir);
  evictOverflow();
}

export function readDriveSummary(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
) {
  activateOwner(ownerKey);
  return summaries.get(choirId) ?? null;
}

export function rememberDriveSummary(
  ownerKey: DriveCacheOwnerKey,
  choir: ChoirSummary,
) {
  activateOwner(ownerKey);
  rememberSummary(choir.id, choir);
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
  summaries.delete(choirId);
}

export function clearDriveLibraryCache() {
  libraries.clear();
  summaries.clear();
  activeOwner = null;
}

function activateOwner(ownerKey: DriveCacheOwnerKey) {
  if (activeOwner === ownerKey) return;
  libraries.clear();
  summaries.clear();
  activeOwner = ownerKey;
}

function evictOverflow() {
  while (summaries.size > MAX_DRIVES) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) return;
    summaries.delete(oldest);
    libraries.delete(oldest);
  }
}

function rememberSummary(choirId: string, choir: ChoirSummary) {
  summaries.delete(choirId);
  summaries.set(choirId, choir);
}
