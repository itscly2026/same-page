import { cacheAnnotationLayers } from "../annotations/annotation-state";
/// <reference types="node" />

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Blob as NodeBlob } from "node:buffer";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { activateVerifiedOfflineScore, findActiveOfflineScore, localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, captureLocalWorkspaceSession, resolveLocalWorkspace } from "../platform/local-workspace";
import { useOfflineScore } from "./use-offline-score";
import { findVerifiedOfflineScore, sha256Hex, verifyOfflineScore } from "./offline-score-verification";

beforeEach(async () => { vi.stubGlobal("Blob", NodeBlob); await localDatabase.open(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function recordFor(scoreId = "score"): Promise<OfflineScoreRecord> {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "drive", scoreId });
  const blob = new Blob([new Uint8Array(1024 * 1024)]);
  const record: OfflineScoreRecord = { ...workspace, key: `${workspace.scopeKey}:v1`, versionId: "v1", fileName: "sample.pdf", sha256: await sha256Hex(await blob.arrayBuffer()), pageCount: 1, blob, active: 1, verifiedAt: 1,
    annotationSnapshot: { cursor: 0, verifiedAt: 1, annotations: [], layers: (["E", "S", "A", "T", "B"] as const).map((slot, index) => ({
      ...workspace, key: `${workspace.scopeKey}:${slot}`, id: `00000000-0000-4000-8000-00000000000${index}`, kind: "shared", sharedSlot: slot, name: slot, sortOrder: index, subscribed: true, subscriptionSource: "product", displayColor: "#a12652", colorSource: "product", adminDefaultColor: "#a12652", driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: false,
    })) } };
  await cacheAnnotationLayers(workspace, record.annotationSnapshot.layers);
  return record;
}

it("50 offline scores do no additional full reads on repeated foreground events", async () => {
  const records = [];
  for (let index = 0; index < 50; index++) {
    const record = await recordFor(String(index));
    await activateVerifiedOfflineScore(record);
    records.push(record);
  }
  const read = vi.spyOn(Blob.prototype, "arrayBuffer");
  function Row({ record }: { record: OfflineScoreRecord }) {
    const state = useOfflineScore(record);
    return <span>{state?.record ? "verified" : "pending"}</span>;
  }
  render(<>{records.map((record) => <Row key={record.key} record={record} />)}</>);
  await waitFor(() => expect(screen.getAllByText("verified")).toHaveLength(50));
  const initial = read.mock.calls.length;
  await act(async () => {
    for (let i = 0; i < 5; i++) { fireEvent(window, new Event("focus")); fireEvent(document, new Event("visibilitychange")); }
  });
  // Observe a bounded foreground window; wait for an extra read if a regression
  // schedules one after React commits. The baseline does issue 50 extra reads.
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(initial), { timeout: 250 }).catch(() => undefined);
  expect(read.mock.calls.length - initial).toBe(0);
  read.mockRestore();
});

it("repeated version replacement frees stored references while an older Blob remains readable", async () => {
  const record = await recordFor();
  await activateVerifiedOfflineScore(record);
  const held = await findVerifiedOfflineScore(record);
  expect(held).not.toBeNull();
  for (let version = 2; version <= 8; version++) await activateVerifiedOfflineScore({ ...record, key: `${record.scopeKey}:v${version}`, versionId: `v${version}` });
  expect(await localDatabase.offlineScores.count()).toBe(1);
  expect((await findVerifiedOfflineScore(record))?.versionId).toBe("v8");
  expect((await held!.blob.arrayBuffer()).byteLength).toBe(1024 * 1024);
});

it("quota failure rolls back replacement and actual open detects same-size corruption", async () => {
  const record = await recordFor();
  await activateVerifiedOfflineScore(record);
  const put = vi.spyOn(localDatabase.offlineScores, "put").mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"));
  await expect(activateVerifiedOfflineScore({ ...record, key: "new", versionId: "v2" })).rejects.toThrow("quota");
  put.mockRestore();
  expect((await findVerifiedOfflineScore(record))?.versionId).toBe("v1");
  const stored = await findActiveOfflineScore(record.ownerKey, record.choirId, record.scoreId);
  await localDatabase.offlineScores.update(stored!.key, { blob: new Blob([new Uint8Array(1024 * 1024).fill(1)]) });
  expect(await findVerifiedOfflineScore(record)).toBeNull();
});

it("never shares successful verification with a different same-size corrupt Blob", async () => {
  const record = await recordFor();
  const corrupted = { ...record, blob: new Blob([new Uint8Array(1024 * 1024).fill(1)]) };
  expect(await Promise.all([verifyOfflineScore(record), verifyOfflineScore(corrupted)])).toEqual([true, false]);
});

it("bounds concurrent verification and shares work only for the same immutable Blob", async () => {
  const record = await recordFor();
  const original = Blob.prototype.arrayBuffer;
  let running = 0, maximum = 0;
  const read = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(async function(this: Blob) {
    running++; maximum = Math.max(maximum, running);
    try { return await original.call(this); } finally { running--; }
  });
  expect(await Promise.all([verifyOfflineScore(record), verifyOfflineScore(record)])).toEqual([true, true]);
  expect(read).toHaveBeenCalledTimes(1);
  const copies = Array.from({ length: 6 }, (_, i) => ({ ...record, key: String(i), blob: new Blob([new Uint8Array(1024 * 1024)]) }));
  expect(await Promise.all(copies.map(verifyOfflineScore))).toEqual([true, true, true, true, true, true]);
  expect(maximum).toBeLessThanOrEqual(2);
});

it("an A to B to A identity change cannot activate a download from the earlier session", async () => {
  await activateAuthenticatedLocalOwner("a");
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: "a", choirId: "drive", scoreId: "score" });
  const epoch = await captureLocalWorkspaceSession(workspace);
  const record = await recordFor();
  await activateAuthenticatedLocalOwner("b");
  await activateAuthenticatedLocalOwner("a");
  await expect(activateVerifiedOfflineScore({ ...record, ...epoch })).rejects.toThrow("local_workspace_owner_changed");
});

it("concurrent offline open requests share one IndexedDB snapshot and full verification", async () => {
  const record = await recordFor();
  await activateVerifiedOfflineScore(record);
  const read = vi.spyOn(Blob.prototype, "arrayBuffer");
  const [first, second] = await Promise.all([findVerifiedOfflineScore(record), findVerifiedOfflineScore(record)]);
  expect(first).toBe(second);
  expect(read).toHaveBeenCalledTimes(1);
});

it("a late older download cannot replace a newer activation from another reader", async () => {
  const record = await recordFor();
  await activateVerifiedOfflineScore({ ...record, key: "v2", versionId: "v2" }, { activeKey: null });
  await expect(activateVerifiedOfflineScore(record, { activeKey: null })).rejects.toThrow("offline_copy_changed_during_download");
  expect((await findVerifiedOfflineScore(record))?.versionId).toBe("v2");
});


it("an image bundle is usable only when its whole manifest and every page hash match", async () => {
  const record = await recordFor("image-copy");
  const bytes = await readFile("renderer/fixtures/specimen-1-2048.png");
  const blob = new Blob([bytes]);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const imageManifest: NonNullable<OfflineScoreRecord["imageManifest"]> = {
    versionId: record.versionId, generation: "11111111-1111-4111-8111-111111111111", sourceSha256: "a".repeat(64), spec: "png-rgb-v1", engine: "pdfium-153.0.7999.0",
    pages: [{ pageNumber: 1, width: 600, height: 800, rotation: 0, crop: [0, 0, 600, 800], assets: [
      { edge: 2048, width: 1583, height: 2048, sizeBytes: bytes.length, sha256: hash },
      { edge: 3072, width: 2304, height: 3072, sizeBytes: 4, sha256: "b".repeat(64) },
    ] }],
  };
  const imageCopy = { ...record, blob, sha256: hash, imageManifest };
  expect(await verifyOfflineScore(imageCopy)).toBe(true);
  const changedManifest = { ...imageManifest, pages: imageManifest.pages.map(page => ({ ...page, assets: page.assets.map(asset => ({ ...asset, sha256: "c".repeat(64) })) })) };
  expect(await verifyOfflineScore({ ...imageCopy, imageManifest: changedManifest })).toBe(false);
  expect(await verifyOfflineScore({ ...imageCopy, pageCount: 2 })).toBe(false);
  expect(await verifyOfflineScore({ ...imageCopy, versionId: "another-version" })).toBe(false);
});

it("clearing files preserves the held document and annotations but fences a late download even with no active copy", async () => {
  const { captureOfflineFileFence, clearLocalFiles, listLocalFiles } = await import("./local-files");
  const record = await recordFor();
  const fence = await captureOfflineFileFence(record);
  await activateVerifiedOfflineScore(record);
  const held = (await listLocalFiles())[0].blob;
  await clearLocalFiles({ ownerKey: record.ownerKey, choirId: record.choirId });
  expect(await listLocalFiles()).toEqual([]);
  expect((await held.arrayBuffer()).byteLength).toBe(1024 * 1024);
  expect(await localDatabase.annotationLayers.where("scopeKey").equals(record.scopeKey).count()).toBe(5);
  await expect(activateVerifiedOfflineScore(record, { activeKey: null, fileFence: fence })).rejects.toThrow("offline_files_cleared");
  // A new explicit open captures the new fence and may download again.
  await activateVerifiedOfflineScore(record, { activeKey: null, fileFence: await captureOfflineFileFence(record) });
  expect(await listLocalFiles()).toHaveLength(1);
});

it("cannot list or clear another user's files and keeps the drive directory", async () => {
  const { clearLocalFiles, listLocalFiles } = await import("./local-files");
  const guest = await recordFor();
  await activateVerifiedOfflineScore(guest);
  await activateAuthenticatedLocalOwner("different-user");
  expect(await listLocalFiles()).toEqual([]);
  await expect(clearLocalFiles({ ownerKey: guest.ownerKey, choirId: guest.choirId })).rejects.toThrow("local_workspace_owner_changed");
  expect(await localDatabase.offlineScores.count()).toBe(1);
});

it("the activation transaction rejects a logout fence before asynchronous watchers run", async () => {
  const { beginLogout } = await import("../auth/logout-fence");
  await activateAuthenticatedLocalOwner("a");
  const record = await recordFor();
  await beginLogout("a", "session");
  await expect(activateVerifiedOfflineScore(record)).rejects.toThrow("local_workspace_owner_changed");
  expect(await findActiveOfflineScore(record.ownerKey, record.choirId, record.scoreId)).toBeUndefined();
});
