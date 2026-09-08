import { MemoryRouter } from "react-router-dom";
import { useAnnotationEditor } from "../annotations/use-annotation-editor";
import { useLiveQuery } from "dexie-react-hooks";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { cacheAnnotationLayers, readAnnotationLayers, saveAnnotationDraft } from "../annotations/annotation-state";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { ReaderLayerPanel } from "./reader-layer-panel";
import { ReaderEditingControls } from "./reader-editing-controls";

const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("reader"), "drive", "score");
const own: AnnotationLayerSummary = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "personal", sharedSlot: null,
  name: "我的笔记", sortOrder: 10000, subscribed: true, subscriptionSource: "personal",
  displayColor: "#b4235a", colorSource: "personal", adminDefaultColor: null,
  driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null,
  canEdit: true, sharing: false, canShare: true,
};
const published: AnnotationLayerSummary = { ...own, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "声部长的笔记", canEdit: false, sharing: true, canShare: false, subscribed: false };
let serverLayers: AnnotationLayerSummary[];
let requests: Array<{ url: string; body: unknown }>;

function Reader() {
  const { editor } = useAnnotationEditor(workspace);
  const layers = useLiveQuery(() => readAnnotationLayers(workspace), [], []);
  return <MemoryRouter><ReaderLayerPanel workspace={workspace} layers={layers} signedIn />
    <ReaderEditingControls editor={editor!} layers={layers} isDisabled={false} activeLayerId={own.id} tool="text" toolColor="#dc2626" onColorChange={() => undefined} onLayerChange={() => undefined} onToolChange={() => undefined} /></MemoryRouter>;
}

beforeEach(async () => {
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
    if (init?.method === "POST" && url.endsWith("/personal-layers")) {
      const body = JSON.parse(String(init.body)); requests.push({ url, body });
      serverLayers.push({ ...own, id: body.id, name: body.name });
      return Response.json({ id: body.id }, { status: 201 });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); requests.push({ url, body });
      if (url.endsWith(`/personal-layers/${own.id}`)) serverLayers[0] = { ...serverLayers[0], sharing: body.sharing };
      if (url.endsWith("/subscription")) serverLayers[1] = { ...serverLayers[1], subscribed: body.subscribed };
      return Response.json(body);
    }
    if (url.endsWith("/layers")) return Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    return Response.json({ cursor: 0, objects: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shares just the current score with a clear audience and supports cancellation", async () => {
  render(<Reader />);
  const share = await screen.findByRole("button", { name: "分享 我的笔记" });
  expect(share).toHaveTextContent("仅自己可见");
  fireEvent.click(share);
  const stop = await screen.findByRole("button", { name: "分享 我的笔记" });
  await waitFor(() => expect(stop).toHaveTextContent("云盘成员可见"));
  await waitFor(() => expect(stop).not.toBeDisabled());
  expect(requests).toEqual([{ url: `/api/choirs/drive/scores/score/personal-layers/${own.id}`, body: { sharing: true, expectedRevision: 0 } }]);
  fireEvent.click(stop);
  await screen.findByRole("button", { name: "分享 我的笔记" });
});

it("subscribes to a member's notes without offering their layer as an editing target", async () => {
  render(<Reader />);
  const toggle = await screen.findByRole("checkbox", { name: "显示 声部长的笔记" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  await waitFor(() => expect(toggle).not.toBeDisabled());
  expect(requests).toEqual([{ url: `/api/choirs/drive/scores/score/personal-layers/${published.id}/subscription`, body: { subscribed: true } }]);
  fireEvent.click(screen.getByRole("button", { name: /当前编辑层/ }));
  expect(screen.queryByRole("button", { name: /声部长的笔记/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "我的笔记" })).toBeEnabled();
});

it("creates another private layer, caches both editing targets, and protects unsynced deletion", async () => {
  render(<Reader />);
  const name = await screen.findByRole("textbox", { name: "新个人层名称" });
  fireEvent.change(name, { target: { value: "演出提示" } });
  fireEvent.click(screen.getByRole("button", { name: "新建个人层" }));
  const toggle = await screen.findByRole("button", { name: "分享 演出提示" });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toHaveTextContent("仅自己可见");
  const newLayer = (await readAnnotationLayers(workspace)).find(layer => layer.name === "演出提示")!;
  fireEvent.click(screen.getByRole("button", { name: /当前编辑层/ }));
  expect(screen.getByRole("button", { name: "演出提示", exact: true })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "关闭写入目标" }));
  await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: newLayer.id, payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "尚未同步" } });
  const card = toggle.closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "删除", exact: true }));
  fireEvent.click(within(card).getByRole("button", { name: "确认删除" }));
  await screen.findByText(/此层有未同步内容或冲突/);
  expect(requests.filter(request => request.url.endsWith(`/personal-layers/${newLayer.id}`))).toHaveLength(0);
});
