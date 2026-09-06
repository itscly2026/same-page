import { Blob as NodeBlob } from "node:buffer";
import { useLiveQuery } from "dexie-react-hooks";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { cacheAnnotationLayers, readAnnotationLayers, readScoreAnnotationState, restoreOfflineAnnotationSnapshot, saveAnnotationDraft } from "../annotations/annotation-state";
import { findVerifiedOfflineScore, sha256Hex, verifyOfflineScore } from "../offline/offline-score-verification";
import { syncAnnotations } from "../annotations/sync";
import { captureOfflineAnnotationSnapshot } from "../annotations/offline-snapshot";
import { activateVerifiedOfflineScore, localDatabase, type OfflineScoreRecord } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { ReaderLayerPanel } from "./reader-layer-panel";
import { ReaderEditingControls } from "./reader-editing-controls";

const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("reader"), "drive", "score");
const own: AnnotationLayerSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "personal", sharedSlot: null,
  name: "Personal", sortOrder: 10000, subscribed: true, subscriptionSource: "personal",
  displayColor: "#b4235a", colorSource: "personal", adminDefaultColor: null,
  driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null,
  canEdit: true, sharing: false, canShare: true,
};
const published: AnnotationLayerSummary = { ...own, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "声部长的笔记", canEdit: false, sharing: true, canShare: false, subscribed: false };
let serverLayers: AnnotationLayerSummary[];
let requests: Array<{ url: string; body: unknown }>;

function Reader() {
  const layers = useLiveQuery(() => readAnnotationLayers(workspace), [], []);
  return <><ReaderLayerPanel workspace={workspace} layers={layers} signedIn />
    <ReaderEditingControls workspace={workspace} layers={layers} isDisabled={false} activeLayerId={own.id} tool="text" onLayerChange={() => undefined} onToolChange={() => undefined} /></>;
}

beforeEach(async () => {
  vi.stubGlobal("Blob", NodeBlob);
  await localDatabase.open();
  await activateAuthenticatedLocalOwner("reader");
  await localDatabase.annotationOutbox.clear();
  await localDatabase.annotations.clear();
  await localDatabase.annotationSyncCursors.clear();
  await localDatabase.offlineScores.clear();
  await localDatabase.syncLeases.clear();
  serverLayers = [{ ...own }, { ...published }]; requests = [];
  await cacheAnnotationLayers(workspace, serverLayers);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); requests.push({ url, body });
      if (url.endsWith("/personal-layer/sharing")) serverLayers[0] = { ...serverLayers[0], sharing: body.sharing };
      if (url.endsWith("/subscription")) serverLayers[1] = { ...serverLayers[1], subscribed: body.subscribed };
      return Response.json(body);
    }
    if (url.endsWith("/layers")) return Response.json({ layers: serverLayers, permissions: { canManageLayers: false } });
    return Response.json({ cursor: 0, objects: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shares just the current score with a clear audience and supports cancellation", async () => {
  render(<Reader />);
  const toggle = await screen.findByRole("checkbox", { name: "向云盘成员分享这份谱的个人层" });
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(/这份谱的现有个人笔记及后续修改/)).toBeVisible();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  await waitFor(() => expect(toggle).not.toBeDisabled());
  expect(requests).toEqual([{ url: "/api/choirs/drive/scores/score/personal-layer/sharing", body: { sharing: true } }]);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
});

it("subscribes to a member's notes without offering their layer as an editing target", async () => {
  render(<Reader />);
  const toggle = await screen.findByRole("checkbox", { name: "订阅 声部长的笔记" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  await waitFor(() => expect(toggle).not.toBeDisabled());
  expect(requests).toEqual([{ url: `/api/choirs/drive/scores/score/personal-layers/${published.id}/subscription`, body: { subscribed: true } }]);
  fireEvent.click(screen.getByRole("button", { name: /当前编辑层/ }));
  expect(screen.queryByRole("button", { name: /声部长的笔记/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "P，Personal" })).toBeEnabled();
});


it("loads older notes on a newly shared layer and removes revoked notes from offline restoration", async () => {
  serverLayers = [{ ...own }];
  const cursors: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/layers")) return Response.json({ layers: serverLayers, permissions: { canManageLayers: false } });
    const cursor = Number(new URL(url, "https://example.test").searchParams.get("cursor")); cursors.push(cursor);
    return Response.json({ cursor: 100, objects: serverLayers.length > 1 && cursor === 0 ? [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", layerId: published.id, version: 1, deleted: false,
      payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "早先写下的笔记" },
      createdByDisplayName: "", updatedByDisplayName: "", updatedAt: 1,
    }] : [] });
  }));
  await syncAnnotations(workspace, { pull: true });
  await syncAnnotations(workspace, { pull: true });
  serverLayers.push({ ...published });
  await syncAnnotations(workspace, { pull: true });
  expect(cursors).toEqual([0, 100, 0]);
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([expect.objectContaining({ layerId: published.id })]);
  const staleRecord: OfflineScoreRecord = {
    ...workspace, key: "offline-test", versionId: "version", fileName: "谱.pdf", sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  expect(await verifyOfflineScore(staleRecord)).toBe(true);
  await localDatabase.offlineScores.put(staleRecord);
  serverLayers = [{ ...own }];
  await syncAnnotations(workspace, { pull: true });
  expect(await findVerifiedOfflineScore(workspace)).not.toBeNull();
  await restoreOfflineAnnotationSnapshot(workspace, staleRecord);
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([]);
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === published.id)).toBe(false);
});


it("keeps paused shared notes but does not restore their layer from an older offline snapshot", async () => {
  const shared: AnnotationLayerSummary = { ...own, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "shared", sharedSlot: "piano", name: "钢琴", sharing: undefined, canShare: undefined };
  serverLayers = [{ ...own }, shared];
  await cacheAnnotationLayers(workspace, serverLayers);
  await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: shared.id,
    payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "保留的伴奏笔记" } });
  const staleRecord: OfflineScoreRecord = {
    ...workspace, key: "paused-offline-test", versionId: "version", fileName: "谱.pdf", sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  expect(await verifyOfflineScore(staleRecord)).toBe(true);
  await localDatabase.offlineScores.put(staleRecord);
  serverLayers = [{ ...own }];
  await syncAnnotations(workspace, { pull: true });
  expect(await findVerifiedOfflineScore(workspace)).not.toBeNull();
  await restoreOfflineAnnotationSnapshot(workspace, staleRecord);
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === shared.id)).toBe(false);
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([expect.objectContaining({ layerId: shared.id })]);
  serverLayers.push(shared);
  await syncAnnotations(workspace, { pull: true });
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === shared.id)).toBe(true);
});


it("does not activate a captured publication after a sync withdraws it during file verification", async () => {
  const candidate: OfflineScoreRecord = {
    ...workspace, key: "inflight-copy", versionId: "version", fileName: "谱.pdf",
    sha256: await sha256Hex(new TextEncoder().encode("test").buffer), pageCount: 1,
    blob: new Blob(["test"]), active: 1, verifiedAt: 1,
    annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace),
  };
  expect(candidate.annotationSnapshot.layers.some(layer => layer.id === published.id)).toBe(true);
  expect(await verifyOfflineScore(candidate)).toBe(true);
  serverLayers = [{ ...own }];
  await syncAnnotations(workspace, { pull: true });
  await activateVerifiedOfflineScore(candidate, { activeKey: null });
  const activated = await findVerifiedOfflineScore(workspace);
  expect(activated).not.toBeNull();
  expect(activated!.annotationSnapshot.layers.some(layer => layer.id === published.id)).toBe(false);
  await restoreOfflineAnnotationSnapshot(workspace, candidate);
  expect((await readAnnotationLayers(workspace)).some(layer => layer.id === published.id)).toBe(false);
});
