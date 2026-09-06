/// <reference types="node" />
import { Blob as NodeBlob } from "node:buffer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ReaderSession } from "./reader-session";
import { localDatabase } from "../platform/local-database";
import { resolveLocalWorkspace } from "../platform/local-workspace";
import { loadPdfDocument } from "./pdf-document";
import { clearReaderDocumentCache } from "./reader-document-cache";
import { findVerifiedOfflineScore, sha256Hex } from "../offline/offline-score-verification";
import type { ScoreSummary } from "../../shared/scores";
import type { AnnotationLayerSummary } from "../../shared/annotations";

// PDF.js and browser/service-worker capabilities are the external boundaries.
// The real session, download, validation, IndexedDB and annotation sync run here.
vi.mock("./pdf-document", () => ({ loadPdfDocument: vi.fn() }));
const sessions: ReaderSession[] = [];
let score: ScoreSummary;
let layers: AnnotationLayerSummary[];
let bytes: Uint8Array<ArrayBuffer>;
let pdfRequests: number;
let failDownload: boolean;
beforeEach(async () => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("navigator", { onLine: true, serviceWorker: { getRegistration: async () => ({active:{}}) } });
  await localDatabase.open();
  pdfRequests = 0;
  failDownload = false;
  bytes = new TextEncoder().encode("%PDF-1.7 fixture");
  score = { id:"score", choirId:"drive", fileName:"练声.pdf", updatedAt:1,
    currentVersion:{id:"v1",versionNumber:1,sizeBytes:bytes.byteLength,sha256:await sha256Hex(bytes.buffer as ArrayBuffer),etag:"v1",pageCount:1,createdAt:1} };
  layers = (["E","S","A","T","B"] as const).map((slot,index) => ({
    id:`00000000-0000-4000-8000-00000000000${index}`,kind:"shared",sharedSlot:slot,name:slot,sortOrder:index,
    subscribed:true,subscriptionSource:"product",displayColor:"#a12652",colorSource:"product",adminDefaultColor:"#a12652",driveSubscribed:null,driveColorOverride:null,scoreSubscriptionOverride:null,canEdit:false,
  }));
  vi.mocked(loadPdfDocument).mockImplementation(() => ({
    promise: Promise.resolve({ document: { numPages:1 } as Awaited<ReturnType<typeof loadPdfDocument>["promise"]>["document"], versionId:score.currentVersion.id }),
    destroy:vi.fn().mockResolvedValue(undefined),
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.endsWith("/bootstrap")) return Response.json({state:"active",score,permissions:{canManage:false}});
    if (input.endsWith("/layers")) return Response.json({layers,permissions:{canManageLayers:false}});
    if (input.includes("/annotations?")) return Response.json({cursor:0,objects:[]});
    if (input.endsWith("/pdf")) { pdfRequests++; return failDownload ? new Response(null,{status:503}) : new Response(bytes); }
    return new Response(null,{status:404});
  }));
});
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); clearReaderDocumentCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open() {
  const workspace = await resolveLocalWorkspace({authenticatedUserId:null,choirId:"drive",scoreId:"score"});
  const session = new ReaderSession(workspace,null); sessions.push(session); session.open(); return session;
}
it("opening a score automatically verifies an offline copy without waiting to display the PDF", async () => {
  const originalFetch = fetch;
  let finish!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const response = await originalFetch(input);
    if (input.endsWith("/pdf")) await new Promise<void>(resolve => { finish = resolve; });
    return response;
  }));
  const session = await open();
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(session.getSnapshot()).toMatchObject({status:"ready",offline:null,downloading:true});
  finish();
  await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({offline:{versionId:"v1"}}));
  expect(session.getSnapshot().downloadMessage).toContain("可以离线打开");
  expect(session.getSnapshot().offline?.annotationSnapshot.layers).toHaveLength(5);
  expect(pdfRequests).toBe(1);
});
it("reopening uses the verified local PDF and does not download it again", async () => {
  const first = await open();
  await vi.waitFor(() => expect(first.getSnapshot().offline?.versionId).toBe("v1"));
  first.dispose();
  clearReaderDocumentCache();
  vi.mocked(loadPdfDocument).mockClear();
  const second = await open();
  await vi.waitFor(() => expect(second.getSnapshot().status).toBe("ready"));
  expect(Object.prototype.toString.call(vi.mocked(loadPdfDocument).mock.calls[0][0])).toBe("[object ArrayBuffer]");
  await second.refresh();
  expect(pdfRequests).toBe(1);
});
it("a failed automatic download keeps online reading available and can be retried explicitly", async () => {
  failDownload = true;
  const session = await open();
  await vi.waitFor(() => expect(session.getSnapshot().downloadMessage).toContain("未完成"));
  expect(session.getSnapshot()).toMatchObject({status:"ready",offline:null,downloading:false});
  await session.refresh();
  expect(pdfRequests).toBe(1);
  failDownload = false;
  await session.download();
  expect(session.getSnapshot().offline?.versionId).toBe("v1");
});

it("a replacement download failure preserves the previous verified copy", async () => {
  const session = await open();
  await vi.waitFor(() => expect(session.getSnapshot().offline?.versionId).toBe("v1"));
  score = {...score,currentVersion:{...score.currentVersion,id:"v2",versionNumber:2}};
  failDownload = true;
  await session.refresh();
  await vi.waitFor(() => expect(session.getSnapshot().downloadMessage).toContain("未完成"));
  expect(session.getSnapshot()).toMatchObject({status:"ready",offline:{versionId:"v1"},score:{currentVersion:{id:"v2"}}});
  expect((await findVerifiedOfflineScore(session.workspace))?.versionId).toBe("v1");
  failDownload = false;
  await session.download();
  expect(session.getSnapshot().offline?.versionId).toBe("v2");
});
it("leaving the reader cancels activation of a delayed download", async () => {
  const originalFetch = fetch;
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const response = await originalFetch(input);
    if (input.endsWith("/pdf")) {
      signal = init?.signal ?? undefined;
      await new Promise<void>(resolve => { finish = resolve; });
    }
    return response;
  }));
  const session = await open();
  await vi.waitFor(() => expect(finish).toBeDefined());
  session.dispose();
  expect(signal?.aborted).toBe(true);
  finish();
  // Reopen offline through the session API after the delayed response has settled.
  vi.stubGlobal("navigator", {onLine:false});
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  const reopened = await open();
  await vi.waitFor(() => expect(reopened.getSnapshot().cloudState).toBe("unavailable"));
  expect(await findVerifiedOfflineScore(reopened.workspace)).toBeNull();
  expect(reopened.getSnapshot().offline).toBeNull();
});
it("reuses the displayed PDF bytes while still validating its checksum and snapshot", async () => {
  const getData = vi.fn(async () => bytes);
  vi.mocked(loadPdfDocument).mockImplementation(() => ({
    promise: Promise.resolve({document: Object.assign({numPages:1} as Awaited<ReturnType<typeof loadPdfDocument>["promise"]>["document"], {getData}),versionId:"v1"}),
    destroy:vi.fn().mockResolvedValue(undefined),
  }));
  const session = await open();
  await vi.waitFor(() => expect(session.getSnapshot().offline?.versionId).toBe("v1"));
  expect(getData).toHaveBeenCalledOnce();
  expect(pdfRequests).toBe(0);
});
it("a new version cancels the old download and automatically prepares the current version", async () => {
  const originalFetch = fetch;
  let finish!: () => void;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (input.includes("/versions/v1/pdf")) await new Promise<void>(resolve => { finish = resolve; });
    return response;
  }));
  const session = await open();
  const activated: string[] = [];
  session.subscribe(() => { const version = session.getSnapshot().offline?.versionId; if (version) activated.push(version); });
  await vi.waitFor(() => expect(finish).toBeDefined());
  score = {...score,currentVersion:{...score.currentVersion,id:"v2",versionNumber:2}};
  await session.refresh();
  finish();
  await vi.waitFor(() => expect(session.getSnapshot().offline?.versionId).toBe("v2"));
  expect(activated).not.toContain("v1");
});

it("keeps the reader usable and its previous copy when refreshed layers succeed but content fails", async () => {
  const session = await open();
  await vi.waitFor(() => expect(session.getSnapshot().offline?.versionId).toBe("v1"));
  const originalFetch = fetch;
  let failPull = true;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input.includes("/annotations?") && failPull) return new Response(null, { status: 503 });
    return originalFetch(input, init);
  }));
  score = { ...score, currentVersion: { ...score.currentVersion, id: "v2", versionNumber: 2 } };
  await session.refresh();
  await vi.waitFor(() => expect(session.getSnapshot().downloadMessage).toContain("未完成"));
  expect(session.getSnapshot()).toMatchObject({ status: "ready", capability: "read-only", offline: { versionId: "v1" } });
  expect((await findVerifiedOfflineScore(session.workspace))?.versionId).toBe("v1");
  failPull = false;
  await session.download();
  expect((await findVerifiedOfflineScore(session.workspace))?.versionId).toBe("v2");
});

it("refreshes layers after preparing bytes instead of activating the opening layer list", async () => {
  const originalFetch = fetch;
  let finish!: () => void;
  let layerRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/layers")) layerRequests++;
    if (input.endsWith("/pdf")) await new Promise<void>(resolve => { finish = resolve; });
    return originalFetch(input, init);
  }));
  const session = await open();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await vi.waitFor(() => expect(session.getSnapshot().capability).toBe("read-only"));
  expect(layerRequests).toBe(1);
  layers = layers.slice(0, 4);
  finish();
  await vi.waitFor(() => expect(session.getSnapshot().offline?.versionId).toBe("v1"));
  expect(layerRequests).toBe(2);
  expect(session.getSnapshot().offline?.annotationSnapshot.layers).toHaveLength(4);
});
