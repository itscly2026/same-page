import { clearLocalFiles, listLocalFiles } from "../offline/local-files";
import { captureOfflineAnnotationSnapshot } from "./offline-snapshot";
import { beforeEach, expect, it, vi } from "vitest";
import { activateVerifiedOfflineScore, localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, resolveLocalWorkspace } from "../platform/local-workspace";
import { cacheAnnotationLayers, queueScoreDrafts, readScoreAnnotationState, saveAnnotationDraft } from "./annotation-state";
import { clearGuestNotes, GUEST_NOTE_LAYER_ID } from "./guest-notes";
import { pushPendingAnnotations } from "./sync";

beforeEach(async () => {
  await localDatabase.open();
  for (const table of localDatabase.tables) await table.clear();
});
it("retains guest notes across reopening and layer refresh, never queues or pushes them", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "public", scoreId: "score" });
  await cacheAnnotationLayers(workspace, []);
  const note = { id: crypto.randomUUID(), layerId: GUEST_NOTE_LAYER_ID, payload: { kind: "text" as const, pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "体验" } };
  await saveAnnotationDraft(workspace, note);
  expect(await queueScoreDrafts(workspace)).toBe(0);
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(await pushPendingAnnotations(workspace, { maxOperations: 100 })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
  localDatabase.close();
  await localDatabase.open();
  await cacheAnnotationLayers(workspace, []);
  const saved = await readScoreAnnotationState(workspace);
  expect(saved.layersReady).toBe(true);
  expect(saved.annotations[0]?.payload).toEqual(note.payload);
  expect(saved.pendingCount).toBe(0);
  await expect(saveAnnotationDraft(workspace, { ...note, id: crypto.randomUUID(), layerId: crypto.randomUUID() })).rejects.toThrow("guest_notes_are_local_only");
  await activateAuthenticatedLocalOwner("member");
  await expect(clearGuestNotes(workspace)).rejects.toThrow();
  const account = await resolveLocalWorkspace({ authenticatedUserId: "member", choirId: "public", scoreId: "score" });
  expect((await readScoreAnnotationState(account)).annotations).toHaveLength(0);
});
it("clears only the current score's experience notes", async () => {
  const options = { authenticatedUserId: null, choirId: "public", scoreId: "score" };
  const first = await resolveLocalWorkspace(options);
  const second = await resolveLocalWorkspace({ ...options, scoreId: "second" });
  for (const workspace of [first, second]) await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: GUEST_NOTE_LAYER_ID, payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "体验" } });
  await cacheAnnotationLayers(first, []);
  await localDatabase.offlineSnapshots.put({ ...first, key: "offline-copy", annotationSnapshot: await captureOfflineAnnotationSnapshot(first) });
  await clearGuestNotes(first);
  expect((await localDatabase.offlineSnapshots.get("offline-copy"))?.annotationSnapshot.annotations).toHaveLength(0);
  expect((await readScoreAnnotationState(first)).annotations).toHaveLength(0);
  expect((await readScoreAnnotationState(second)).annotations).toHaveLength(1);
});

it("isolates signed-in experience from account notes without changing the active account", async () => {
  const options = { authenticatedUserId: "member", choirId: "public", scoreId: "score" };
  const account = await resolveLocalWorkspace(options);
  const experience = await resolveLocalWorkspace({ ...options, experience: true });
  expect(experience.scopeKey).not.toBe(account.scopeKey);
  await cacheAnnotationLayers(experience, []);
  await saveAnnotationDraft(experience, { id: crypto.randomUUID(), layerId: GUEST_NOTE_LAYER_ID, payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "体验" } });
  expect(await queueScoreDrafts(experience)).toBe(0);
  expect((await readScoreAnnotationState(account)).annotations).toHaveLength(0);
  expect((await readScoreAnnotationState(experience)).layersReady).toBe(true);
  await activateVerifiedOfflineScore({ ...experience, key: "experience-pdf", versionId: "v1", fileName: "体验.pdf", pageCount: 1, sha256: "a".repeat(64), blob: new Blob(["pdf"]), annotationSnapshot: await captureOfflineAnnotationSnapshot(experience) });
  expect((await listLocalFiles()).map(file => file.key)).toEqual(["experience-pdf"]);
  await clearLocalFiles(experience);
  expect(await listLocalFiles()).toEqual([]);
  expect((await readScoreAnnotationState(experience)).annotations).toHaveLength(1);
  await activateAuthenticatedLocalOwner("other");
  await expect(readScoreAnnotationState(experience)).rejects.toThrow();
});
