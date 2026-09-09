import { installReadingPreferenceLocks } from "../../test/reading-preference-locks";
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
    installReadingPreferenceLocks();
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
      if (!serverLayers.some(layer => layer.id === body.id)) serverLayers.push({ ...own, id: body.id, name: body.name });
      return Response.json({ id: body.id }, { status: 201 });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)); requests.push({ url, body });
      if (url.endsWith(`/personal-layers/${own.id}`)) serverLayers[0] = { ...serverLayers[0], sharing: body.sharing };
      if (url.endsWith("/subscription")) serverLayers[1] = { ...serverLayers[1], subscribed: body.subscribed };
      return Response.json(body);
    }
    if (url.endsWith("/layers?state=deleted")) return Response.json({ layers: [], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    if (url.endsWith("/layers")) return Response.json({ layers: serverLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    return Response.json({ cursor: 0, objects: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shares just the current score with a clear audience and supports cancellation", async () => {
  render(<Reader />);
  const share = await screen.findByRole("switch", { name: "公开 我的笔记" });
  expect(share).not.toBeChecked();
  fireEvent.click(share);
  const stop = await screen.findByRole("switch", { name: "公开 我的笔记" });
  await waitFor(() => expect(stop).toBeChecked());
  await waitFor(() => expect(stop).not.toBeDisabled());
  expect(requests).toEqual([{ url: `/api/choirs/drive/scores/score/personal-layers/${own.id}`, body: { sharing: true, expectedRevision: 0 } }]);
  fireEvent.click(stop);
  await screen.findByRole("switch", { name: "公开 我的笔记" });
});

it("subscribes to a member's notes without offering their layer as an editing target", async () => {
  render(<Reader />);
  const toggle = await screen.findByRole("checkbox", { name: "显示 声部长的笔记" });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  await waitFor(() => expect(toggle).not.toBeDisabled());
  await waitFor(() => expect(requests).toEqual([{ url: `/api/choirs/drive/scores/score/personal-layers/${published.id}/subscription`, body: { subscribed: true } }]));
  fireEvent.click(screen.getByRole("button", { name: /当前编辑层/ }));
  expect(screen.queryByRole("button", { name: /声部长的笔记/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "我的笔记" })).toBeEnabled();
});

it("creates another private layer, caches both editing targets, and protects unsynced deletion", async () => {
  render(<Reader />);
  expect(screen.queryByRole("textbox", { name: "新个人层名称" })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: /新建个人层/ }));
  const name = await screen.findByRole("textbox", { name: "新个人层名称" });
  fireEvent.change(name, { target: { value: "演出提示" } });
  fireEvent.click(screen.getByRole("button", { name: "新建个人层" }));
  const toggle = await screen.findByRole("switch", { name: "公开 演出提示" });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  const newLayer = (await readAnnotationLayers(workspace)).find(layer => layer.name === "演出提示")!;
  fireEvent.click(screen.getByRole("button", { name: /当前编辑层/ }));
  expect(screen.getByRole("button", { name: "演出提示" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "关闭写入目标" }));
  await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: newLayer.id, payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "尚未同步" } });
  fireEvent.click(screen.getByRole("button", { name: "管理个人层" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "管理个人层" }));
  const card = (await within(screen.getByRole("region", { name: "个人层管理" })).findByText("演出提示")).closest("article")!;
  await waitFor(() => expect(within(card).getByRole("button", { name: "删除" })).toBeEnabled());
  fireEvent.click(within(card).getByRole("button", { name: "删除" }));
  fireEvent.click(within(card).getByRole("button", { name: "确认删除" }));
  await screen.findByText(/此层有未同步内容或冲突/);
  expect(requests.filter(request => request.url.endsWith(`/personal-layers/${newLayer.id}`))).toHaveLength(0);
});

it.each(["submit", "retry"])("reuses the creation identity after a lost response through %s", async route => {
  const originalFetch = fetch;
  let loseResponse = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const result = await originalFetch(input, init);
    if (init?.method === "POST" && String(input).endsWith("/personal-layers") && loseResponse) {
      loseResponse = false;
      throw new Error("response lost after commit");
    }
    return result;
  }));
  render(<Reader />);
  fireEvent.click(await screen.findByRole("button", { name: /新建个人层/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "新个人层名称" }), { target: { value: "排练记录" } });
  fireEvent.click(screen.getByRole("button", { name: "新建个人层" }));
  await screen.findByRole("button", { name: "重试" });
  fireEvent.click(screen.getByRole("button", { name: route === "retry" ? "重试" : "新建个人层" }));
  await screen.findByRole("switch", { name: "公开 排练记录" });
  expect(serverLayers.filter(layer => layer.name === "排练记录")).toHaveLength(1);
  expect(requests[0].body).toEqual(requests[1].body);
  expect(screen.queryByRole("textbox", { name: "新个人层名称" })).not.toBeInTheDocument();
});

it("closes a confirmed creation even when refreshing fails and retries only the refresh", async () => {
  const originalFetch = fetch;
  let failRefresh = true;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/layers") && failRefresh) throw new Error("offline");
    return originalFetch(input, init);
  }));
  render(<Reader />);
  fireEvent.click(await screen.findByRole("button", { name: /新建个人层/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "新个人层名称" }), { target: { value: "排练记录" } });
  fireEvent.click(screen.getByRole("button", { name: "新建个人层" }));
  await screen.findByRole("button", { name: "重试" });
  expect(screen.queryByRole("textbox", { name: "新个人层名称" })).not.toBeInTheDocument();
  failRefresh = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("switch", { name: "公开 排练记录" });
  expect(requests.filter(request => request.url.endsWith("/personal-layers"))).toHaveLength(1);
});

it("keeps other deleted layers available after restoring one and after unrelated mutations", async () => {
  const originalFetch = fetch;
  let deletedLayers = [
    { ...own, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "旧排练", deletedAt: Date.now(), revision: 1 },
    { ...own, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "旧演出", deletedAt: Date.now(), revision: 1 },
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/layers?state=deleted")) return Response.json({ layers: deletedLayers, sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    if (init?.method === "PUT" && JSON.parse(String(init.body)).action === "restore") {
      const restored = deletedLayers.find(layer => String(input).endsWith(layer.id))!;
      serverLayers.push({ ...restored, deletedAt: null });
      deletedLayers = deletedLayers.filter(layer => layer.id !== restored.id);
    }
    return originalFetch(input, init);
  }));
  render(<Reader />);
  fireEvent.click(await screen.findByRole("button", { name: "管理个人层" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "已删除个人层" }));
  fireEvent.click(await screen.findByRole("button", { name: "恢复 旧排练" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "恢复 旧排练" })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "恢复 旧演出" })).toBeEnabled();
  fireEvent.click(screen.getByRole("switch", { name: "公开 我的笔记" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "恢复 旧演出" })).toBeEnabled());
  expect(screen.queryByText("没有可恢复的个人层。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "恢复 旧演出" }));
  await screen.findByText("没有可恢复的个人层。");
});

it("offers guests login with a return to this score instead of an inaccessible preference page", () => {
  render(<MemoryRouter><ReaderLayerPanel workspace={workspace} layers={[]} signedIn={false} /></MemoryRouter>);
  const login = screen.getByRole("link", { name: "登录后设置默认显示" });
  expect(login).toHaveAttribute("href", "/login?returnTo=%2Fchoirs%2Fdrive%2Fscores%2Fscore&panel=layers");
  expect(screen.queryByRole("link", { name: "设置此云盘的默认显示" })).not.toBeInTheDocument();
});

it("keeps sharing private until the server confirms and preserves privacy after rejection", async () => {
  const originalFetch = fetch;
  let respond: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT" && String(input).endsWith(`/personal-layers/${own.id}`)) return new Promise<Response>(resolve => { respond = resolve; });
    return originalFetch(input, init);
  }));
  render(<Reader />);
  const sharing = await screen.findByRole("switch", { name: "公开 我的笔记" });
  fireEvent.click(sharing);
  await waitFor(() => expect(sharing).toBeDisabled());
  expect(sharing).not.toBeChecked();
  expect(screen.getByText("仅自己可见")).toBeInTheDocument();
  respond(new Response(null, { status: 403 }));
  await waitFor(() => expect(sharing).not.toBeDisabled());
  expect(sharing).not.toBeChecked();
});

it("can reopen the single-layer delete confirmation after cancelling without changing its target", async () => {
  render(<Reader />);
  const openDelete = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "管理个人层" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除 我的笔记" }));
    return screen.findByRole("group", { name: "删除 我的笔记" });
  };
  const first = await openDelete();
  fireEvent.click(within(first).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("group", { name: "删除 我的笔记" })).not.toBeInTheDocument();
  expect(within(await openDelete()).getByRole("button", { name: "确认删除" })).toBeEnabled();
  expect(requests).toEqual([]);
});

it("updates shared and personal visibility while PUT is delayed without locking other layers or pulling notes", async () => {
  const shared: AnnotationLayerSummary = { ...own, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", kind: "shared", sharedSlot: "S", name: "Soprano", subscribed: false, driveSubscribed: false, adminDefaultColor: "#dc2626", subscriptionSource: "drive", colorSource: "admin" };
  await cacheAnnotationLayers(workspace, [shared, own, published]);
  const pending: Array<() => void> = [];
  const fetchMock = vi.fn<typeof fetch>(async () => { await new Promise<void>(resolve => pending.push(resolve)); return Response.json({}); });
  vi.stubGlobal("fetch", fetchMock);
  render(<Reader />);
  const soprano = await screen.findByRole("checkbox", { name: "显示 Soprano" });
  fireEvent.click(soprano);
  expect(soprano).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "显示 我的笔记" })).toBeEnabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "显示 我的笔记" }));
  expect(screen.getByRole("checkbox", { name: "显示 我的笔记" })).not.toBeChecked();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.every(([, init]) => init?.method === "PUT")).toBe(true);
  for (const release of pending) release();
  await waitFor(async () => expect((await localDatabase.readingPreferences.toArray()).every(row => !row.pending)).toBe(true));
});

it("retains the choice but never claims saved when local persistence fails", async () => {
  const write = vi.spyOn(localDatabase.readingPreferences, "put").mockRejectedValueOnce(new Error("quota"));
  render(<Reader />);
  const toggle = await screen.findByRole("checkbox", { name: "显示 我的笔记" });
  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  await screen.findByText("尚未保存到本机，请重试。");
  expect(toggle).not.toBeChecked();
  expect(requests).toHaveLength(0);
  write.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("已同步。");
  expect((await readAnnotationLayers(workspace)).find(layer => layer.id === own.id)?.subscribed).toBe(false);
});

it("keeps a deleted target's refresh failure reachable and retries without deleting again", async () => {
  serverLayers.push({ ...own, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", name: "演出提示" });
  await cacheAnnotationLayers(workspace, serverLayers);
  const originalFetch = fetch;
  let failDeleted = false;
  let deletes = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT" && JSON.parse(String(init.body)).action === "delete") {
      deletes++; failDeleted = true; serverLayers = serverLayers.filter(layer => layer.id !== own.id);
      return Response.json({});
    }
    if (url.endsWith("/layers?state=deleted")) {
      if (failDeleted) { failDeleted = false; return new Response(null, { status: 503 }); }
      return Response.json({ layers: deletes ? [{ ...own, deletedAt: Date.now(), revision: 1 }] : [], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    }
    return originalFetch(input, init);
  }));
  render(<Reader />);
  fireEvent.click(await screen.findByRole("button", { name: "管理个人层" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "管理个人层" }));
  const manager = await screen.findByRole("region", { name: "个人层管理" });
  const card = within(manager).getByText("我的笔记").closest("article")!;
  await waitFor(() => expect(within(card).getByRole("button", { name: "删除" })).toBeEnabled());
  fireEvent.click(within(card).getByRole("button", { name: "删除" }));
  fireEvent.click(within(card).getByRole("button", { name: "确认删除" }));
  await within(manager).findByText("修改已保存，内容刷新失败。请重试刷新。");
  expect(screen.getByRole("button", { name: "管理个人层" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "显示 演出提示" })).toBeEnabled();
  fireEvent.click(within(manager).getByRole("button", { name: "重试" }));
  await within(manager).findByRole("button", { name: "恢复 我的笔记" });
  expect(deletes).toBe(1);
});
