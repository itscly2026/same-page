import { ReaderSession } from "../reader/reader-session";
import { loadPdfDocument } from "../reader/pdf-document";
import { clearReaderDocumentCache } from "../reader/reader-document-cache";
import { noCapabilities } from "../../shared/drive-permissions";
import { findVerifiedOfflineScore } from "../offline/offline-score-verification";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OfflineScoreControl } from "./offline-score-control";
import { useOfflineScore } from "../offline/use-offline-score";
import { Blob as NodeBlob } from "node:buffer";
import { sha256Hex } from "../offline/offline-score-verification";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { localDatabase, type OfflineScoreRecord } from "../platform/local-database";

vi.mock("../reader/pdf-document", () => ({ loadPdfDocument: vi.fn() }));
vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => "user:user" }));
vi.mock("../offline/use-offline-score", async (original) => ({
  ...await original<typeof import("../offline/use-offline-score")>(), useOfflineScore: vi.fn(),
}));

vi.mock("../platform/local-workspace", async (original) => {
  const actual = await original<typeof import("../platform/local-workspace")>();
  return { ...actual, resolveLocalWorkspace: async () => actual.createLocalWorkspace(actual.authenticatedLocalOwnerKey("user"), "drive", "score") };
});

const bytes = new TextEncoder().encode("%PDF-1.7 fixture");
const downloadPdf = vi.fn<() => Promise<Response>>();
const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("user"), "drive", "score");
const score = { id: "score", choirId: "drive", fileName: "Long rehearsal score.pdf", updatedAt: 1,
  currentVersion: { id: "v2", versionNumber: 2, sizeBytes: bytes.byteLength, sha256: "hash", etag: "etag", pageCount: 1, createdAt: 1 } };
function verified(versionId = "v2"): OfflineScoreRecord {
  return { key: "record", ...workspace, versionId, fileName: score.fileName, sha256: "hash", pageCount: 1,
    blob: new Blob(), active: 1, verifiedAt: 1, annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } };
}
function state(record: OfflineScoreRecord | null, invalid = false) {
  vi.mocked(useOfflineScore).mockReturnValue({ scopeKey: workspace.scopeKey, record, invalid });
}
beforeEach(async () => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("navigator", { onLine: true, serviceWorker: { getRegistration: async () => ({ active: {} }) } });
  await localDatabase.open(); await activateAuthenticatedLocalOwner("user"); vi.clearAllMocks(); state(null);
  score.currentVersion.sha256 = await sha256Hex(bytes.buffer);
  downloadPdf.mockResolvedValue(new Response(bytes));
  vi.mocked(loadPdfDocument).mockReturnValue({ promise: Promise.resolve({ document: { numPages: 1 } as Awaited<ReturnType<typeof loadPdfDocument>["promise"]>["document"], versionId: "v2" }), destroy: vi.fn().mockResolvedValue(undefined) });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input.endsWith("/bootstrap")) return Response.json({ state: "active", score, permissions: { capabilities: noCapabilities() } });
    if (input.endsWith("/pdf")) return downloadPdf();
    if (input.endsWith("/layers")) return Response.json({ layers: [{ id: "00000000-0000-4000-8000-000000000001", kind: "personal", sharedSlot: null, name: "我的笔记", sortOrder: 0, subscribed: true, subscriptionSource: "product", displayColor: "#a12652", colorSource: "product", adminDefaultColor: "#a12652", driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: true }], sharedLayerRevision: 0, permissions: { canManageLayers: false } });
    if (input.includes("/annotations?")) return Response.json({ cursor: 0, objects: [] });
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => { clearReaderDocumentCache(); vi.unstubAllGlobals(); });

it("downloads once and does not claim offline availability before verified data arrives", async () => {
  let finish!: () => void;
  downloadPdf.mockImplementation(() => new Promise<Response>((resolve) => { finish = () => resolve(new Response(bytes)); }));
  const view = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(downloadPdf).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status")).toHaveTextContent("正在下载并校验");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /离线副本：.*正在下载/ }));
  expect(downloadPdf).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("status")).not.toHaveTextContent("正在下载"));
  expect(screen.getByRole("status")).not.toHaveTextContent("可离线使用");
  state(verified());
  view.rerender(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  expect(screen.getByRole("status")).toHaveTextContent("可离线使用");
});

it("opens ready details on tap without downloading again", async () => {
  state(verified());
  render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /离线副本：.*可离线使用/ }));
  const dialog = await screen.findByRole("dialog", { name: "离线副本" });
  expect(within(dialog).getByText("已保存在这台设备上，断网也能打开。")).toBeInTheDocument();
  expect(downloadPdf).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it.each(["stale", "invalid"])("makes a %s copy downloadable without a ready mark", async (kind) => {
  state(kind === "stale" ? verified("v1") : null, kind === "invalid");
  const { container } = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  expect(container.querySelector('[data-state="ready"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /下载.*离线副本：/ }));
  await waitFor(() => expect(downloadPdf).toHaveBeenCalledTimes(1));
});

it("exposes download failure and allows retry inside the details", async () => {
  downloadPdf.mockRejectedValueOnce(new Error("network"));
  render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("下载未完成"));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "重试下载" }));
  await waitFor(() => expect(downloadPdf).toHaveBeenCalledTimes(2));
});



it("explains that a failed update leaves only the older offline version available", async () => {
  state(verified("v1"));
  downloadPdf.mockRejectedValueOnce(new Error("network"));
  render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载新版离线副本：/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("旧版 PDF 仍可离线使用，当前版本尚未准备好"));
});

it("keeps availability unknown when download fails before inspection completes", async () => {
  vi.mocked(useOfflineScore).mockReturnValue(undefined);
  downloadPdf.mockRejectedValueOnce(new Error("network"));
  const view = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("尚未确认本机副本"));
  expect(screen.getByRole("status")).not.toHaveTextContent("尚不可离线使用");
  state(verified("v1"));
  view.rerender(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  expect(screen.getByRole("status")).toHaveTextContent("旧版 PDF 仍可离线使用");
});


it("list download continues through navigation and the reader shares its preparation", async () => {
  let finish!: () => void;
  downloadPdf.mockImplementation(() => new Promise<Response>(resolve => { finish = () => resolve(new Response(bytes)); }));
  const view = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(downloadPdf).toHaveBeenCalledOnce());
  view.unmount();
  const reader = new ReaderSession(workspace, "user");
  try {
    reader.open();
    await vi.waitFor(() => expect(reader.getSnapshot()).toMatchObject({ status: "ready", downloading: true }));
    finish();
    await vi.waitFor(() => expect(reader.getSnapshot().offline?.versionId).toBe("v2"));
    expect(downloadPdf).toHaveBeenCalledOnce();
  } finally { reader.dispose(); }
});

it("clicking download in the list retains an automatic reader task after the reader exits", async () => {
  let finish!: () => void;
  downloadPdf.mockImplementation(() => new Promise<Response>(resolve => { finish = () => resolve(new Response(bytes)); }));
  const reader = new ReaderSession(workspace, "user");
  try {
    reader.open();
    await vi.waitFor(() => expect(downloadPdf).toHaveBeenCalledOnce());
    render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在下载"));
    fireEvent.click(screen.getByRole("button", { name: /离线副本：/ }));
    reader.dispose();
    finish();
    await vi.waitFor(async () => expect((await findVerifiedOfflineScore(workspace))?.versionId).toBe("v2"));
    expect(downloadPdf).toHaveBeenCalledOnce();
  } finally { reader.dispose(); }
});
