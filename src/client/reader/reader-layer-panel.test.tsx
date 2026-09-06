import { useLiveQuery } from "dexie-react-hooks";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { cacheAnnotationLayers, readAnnotationLayers } from "../annotations/annotation-state";
import { localDatabase } from "../platform/local-database";
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
  expect(screen.getByRole("button", { name: "P，我的笔记" })).toBeEnabled();
});
