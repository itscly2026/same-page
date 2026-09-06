import type { ChoirSummary } from "../../shared/choirs";
import type { ScoreListResponse } from "../../shared/scores";
import { onReaderIdentityChange } from "../reader/reader-cache-events";

export type DriveCacheOwnerKey = `user:${string}` | `guest:${string}`;

export interface DriveLibrarySnapshot {
  choir: ChoirSummary;
  result: ScoreListResponse;
  updatedAt: number;
}

export interface DriveLibraryCacheDiagnostic {
  event:
    | "identity-clear"
    | "invalidate"
    | "owner-switch"
    | "prepare-return"
    | "read-hit"
    | "read-miss"
    | "remember-library";
  ownerKind: "guest" | "user" | null;
  libraryCount: number;
  hasReturningDrive: boolean;
}

const MAX_DRIVES = 6;
const MAX_DIAGNOSTICS = 30;
const libraries = new Map<string, DriveLibrarySnapshot>();
const summaries = new Map<string, ChoirSummary>();
const diagnostics: DriveLibraryCacheDiagnostic[] = [];
let activeOwner: DriveCacheOwnerKey | null = null;
let ownerController = new AbortController();
let returningDrive: { ownerKey: DriveCacheOwnerKey; choirId: string } | null = null;

onReaderIdentityChange(() => {
  recordDiagnostic("identity-clear");
  clearDriveLibraryCache();
});

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
  if (!cached) {
    recordDiagnostic("read-miss");
    return null;
  }
  libraries.delete(choirId);
  libraries.set(choirId, cached);
  recordDiagnostic("read-hit");
  return { ...cached };
}

export function rememberDriveLibrary(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
  library: Pick<DriveLibrarySnapshot, "choir" | "result">,
) {
  activateOwner(ownerKey);
  libraries.delete(choirId);
  libraries.set(choirId, {
    ...library,
    updatedAt: Date.now(),
  });
  rememberSummary(choirId, library.choir);
  evictOverflow();
  recordDiagnostic("remember-library");
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

// A late request cannot reactivate an owner after a switch or explicit clear.
export function captureDriveLibraryOwner(ownerKey: DriveCacheOwnerKey) {
  activateOwner(ownerKey);
  return ownerController.signal;
}

export function invalidateDriveLibrary(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
) {
  activateOwner(ownerKey);
  libraries.delete(choirId);
  summaries.delete(choirId);
  if (returningDrive?.choirId === choirId) returningDrive = null;
  recordDiagnostic("invalidate");
}

export function prepareDriveLibraryReturn(
  ownerKey: DriveCacheOwnerKey,
  choirId: string,
) {
  if (activeOwner !== ownerKey || !libraries.has(choirId)) return;
  returningDrive = { ownerKey, choirId };
  recordDiagnostic("prepare-return");
}

export function readReturningDriveCacheOwner(choirId: string) {
  return returningDrive?.choirId === choirId
    ? returningDrive.ownerKey
    : null;
}

export function clearDriveLibraryCache() {
  ownerController.abort();
  ownerController = new AbortController();
  libraries.clear();
  summaries.clear();
  activeOwner = null;
  returningDrive = null;
}

export function getDriveLibraryCacheDiagnostics() {
  return diagnostics.map((diagnostic) => ({ ...diagnostic }));
}

function activateOwner(ownerKey: DriveCacheOwnerKey) {
  if (activeOwner === ownerKey) return;
  ownerController.abort();
  ownerController = new AbortController();
  libraries.clear();
  summaries.clear();
  returningDrive = null;
  activeOwner = ownerKey;
  recordDiagnostic("owner-switch");
}

function recordDiagnostic(event: DriveLibraryCacheDiagnostic["event"]) {
  diagnostics.push({
    event,
    ownerKind: activeOwner?.startsWith("user:") ? "user" : activeOwner ? "guest" : null,
    libraryCount: libraries.size,
    hasReturningDrive: returningDrive !== null,
  });
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
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
