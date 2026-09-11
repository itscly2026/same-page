import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectiveCapabilities, emptyPermissions } from "../../shared/drive-permissions";
import { activateAuthenticatedLocalOwner } from "../platform/local-workspace";
import { localDatabase } from "../platform/local-database";
import { DriveLibrary } from "./drive-library";
import { clearDriveLibraryCache, readDriveLibrary } from "./drive-library-cache";
import { driveLibraryTransport, type DriveLibraryAccess, type DriveLibraryTransport } from "./drive-library-transport";
import * as directories from "./local-drive-directory";
import { ScoreActionDialog } from "./score-action-dialog";
import { useScoreFileAction } from "./use-score-file-action";

const score = { id: "score", choirId: "drive", fileName: "原谱.pdf", updatedAt: 1,
  currentVersion: { id: "version", versionNumber: 1, sizeBytes: 100, sha256: "a".repeat(64), etag: "one", pageCount: 1, createdAt: 1 } };
const opened = (scores = [score]): DriveLibraryAccess & { kind: "opened" } => ({
  kind: "opened", choir: { id: "drive", name: "云盘", guestAdmissionMode: "invite" }, isMember: true,
  result: { scores, storage: { usedBytes: 100, limitBytes: 1000 }, permissions: { capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()) } },
});
const libraries: DriveLibrary[] = [];
async function setup() {
  await activateAuthenticatedLocalOwner("one");
  const transport = { change: driveLibraryTransport("drive").change, load: vi.fn<DriveLibraryTransport["load"]>().mockResolvedValue(opened()), join: vi.fn<DriveLibraryTransport["join"]>().mockResolvedValue(null) };
  const library = new DriveLibrary("user:one", "drive", transport);
  libraries.push(library);
  library.setAuthenticated(true); library.start(); await library.whenSettled();
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", request);
  const complete = vi.fn();
  return { library, transport, request, complete };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => { clearDriveLibraryCache(); window.sessionStorage.clear(); await localDatabase.open(); });
afterEach(() => { libraries.splice(0).forEach(library => library.stop()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("recovers a confirmed deletion after local persistence and then reading fail without another DELETE", async () => {
  const { library, transport, request, complete } = await setup();
  const remove = vi.spyOn(directories, "removeLocalDriveScore").mockRejectedValueOnce(new Error("disk unavailable"));
  const { result } = renderHook(() => useScoreFileAction(library, score, "trash", complete));
  await act(async () => { await result.current.submit(""); });
  expect(library.getSnapshot().scores).toEqual([]);
  expect(result.current).toMatchObject({ blocked: true, needsRefresh: true });
  expect(result.current.message).toContain("已保存");
  expect(complete).not.toHaveBeenCalled();
  transport.load.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await result.current.submit(""); await result.current.retry(); });
  expect(result.current.message).toContain("已保存");
  expect(result.current.blocked).toBe(true);
  expect((await directories.readLocalDriveDirectories("one"))[0].scores).toEqual([]);
  transport.load.mockResolvedValue(opened([]));
  await act(async () => { await Promise.all([result.current.retry(), result.current.retry()]); });
  expect(complete).toHaveBeenCalledExactlyOnceWith("文件已移到回收站，将在三十天后自动删除。");
  expect(remove).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/choirs/drive/scores/score", expect.objectContaining({ method: "DELETE" }));
});

it("serializes rename submission and preserves the confirmed filename through failed reads", async () => {
  const { library, transport, request, complete } = await setup();
  const response = deferred<Response>(); request.mockReturnValue(response.promise);
  transport.load.mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useScoreFileAction(library, score, "rename", complete));
  let submission!: Promise<void>;
  await act(async () => { submission = result.current.submit("  新谱  "); await result.current.submit("错误重放"); });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { response.resolve(Response.json({ score: { id: score.id, fileName: "新谱.pdf", trashed: false } })); await submission; });
  expect(library.getSnapshot().scores[0]).toEqual({ ...score, fileName: "新谱.pdf" });
  expect(readDriveLibrary("user:one", "drive")?.result.scores[0].fileName).toBe("新谱.pdf");
  expect((await directories.readLocalDriveDirectories("one"))[0].scores[0].fileName).toBe("新谱.pdf");
  expect(result.current.message).toContain("已保存");
  transport.load.mockResolvedValue(opened([{ ...score, fileName: "新谱.pdf" }]));
  await act(async () => { await result.current.retry(); });
  expect(complete).toHaveBeenCalledExactlyOnceWith("文件已重命名。");
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/choirs/drive/scores/score", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ fileName: "新谱.pdf" }) }));
});

it.each(["network", "persistence"])("keeps uncertain writes blocked through a %s recovery failure without repeating them", async failure => {
  const { library, transport, request, complete } = await setup();
  request.mockRejectedValue(new TypeError("connection lost"));
  const { result } = renderHook(() => useScoreFileAction(library, score, "trash", complete));
  await act(async () => { await result.current.submit(""); });
  expect(result.current.message).toContain("操作结果未确认");
  if (failure === "network") transport.load.mockRejectedValueOnce(new Error("offline"));
  else vi.spyOn(directories, "rememberLocalDriveDirectory").mockRejectedValueOnce(new Error("disk unavailable"));
  await act(async () => { await result.current.retry(); await result.current.submit(""); });
  expect(result.current.blocked).toBe(true);
  await act(async () => { await result.current.retry(); });
  expect(result.current).toMatchObject({ blocked: false, needsRefresh: false });
  expect(complete).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(library.getSnapshot().scores).toEqual([score]);
});

it("ignores a departed dialog's write response after the local owner changes", async () => {
  const { library, request, complete } = await setup();
  const response = deferred<Response>(); request.mockReturnValue(response.promise);
  const { result, unmount } = renderHook(() => useScoreFileAction(library, score, "rename", complete));
  let submission!: Promise<void>;
  act(() => { submission = result.current.submit("迟到"); });
  unmount(); library.stop(); await activateAuthenticatedLocalOwner("two");
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await submission; });
  expect(complete).not.toHaveBeenCalled();
  expect(library.getSnapshot().scores).toEqual([score]);
  expect(await directories.readLocalDriveDirectories("two")).toEqual([]);
});

it("does not finish an unmounted dialog when its recovery read later completes", async () => {
  const { library, transport, complete } = await setup();
  transport.load.mockRejectedValueOnce(new Error("offline"));
  const { result, unmount } = renderHook(() => useScoreFileAction(library, score, "trash", complete));
  await act(async () => { await result.current.submit(""); });
  const read = deferred<Awaited<ReturnType<DriveLibraryTransport["load"]>>>();
  transport.load.mockReturnValue(read.promise);
  let retry!: Promise<void>;
  await act(async () => { retry = result.current.retry(); });
  unmount();
  await act(async () => { read.resolve(opened([])); await retry; });
  expect(complete).not.toHaveBeenCalled();
});

it("shows the domain rejection and offers read-only recovery in the real dialog", async () => {
  const { library, request, complete } = await setup();
  request.mockResolvedValue(Response.json({ error: "filename_conflict" }, { status: 409 }));
  render(<ScoreActionDialog library={library} choirId="drive" selection={{ score, action: "rename" }} onClose={() => {}} onComplete={complete} />);
  fireEvent.change(screen.getByRole("textbox", { name: "文件名" }), { target: { value: "已存在" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("文件库已有同名文件");
  expect(screen.getByRole("button", { name: "确认" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重新读取状态" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "确认" })).toBeEnabled());
  expect(request).toHaveBeenCalledTimes(1);
  expect(complete).not.toHaveBeenCalled();
});

it("finishes a normal dialog action after the directory is persisted and refreshed", async () => {
  const { library, transport, request, complete } = await setup();
  transport.load.mockResolvedValue(opened([]));
  render(<ScoreActionDialog library={library} choirId="drive" selection={{ score, action: "trash" }} onClose={() => {}} onComplete={complete} />);
  fireEvent.click(screen.getByRole("button", { name: "移到回收站" }));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  expect((await localDatabase.driveDirectories.toArray())[0].scores).toEqual([]);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(["unconfirmed", "saved"])("retains %s recovery across closing and reopening the real dialog", async outcome => {
  const { library, transport, request, complete } = await setup();
  if (outcome === "unconfirmed") request.mockRejectedValueOnce(new TypeError("connection lost"));
  else vi.spyOn(directories, "renameLocalDriveScore").mockRejectedValueOnce(new Error("disk unavailable"));
  const close = vi.fn();
  const element = <ScoreActionDialog library={library} choirId="drive" selection={{ score, action: "rename" }} onClose={close} onComplete={complete} />;
  const first = render(element);
  fireEvent.change(screen.getByRole("textbox", { name: "文件名" }), { target: { value: "新谱" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(outcome === "saved" ? "已保存" : "未确认");
  fireEvent.click(screen.getByRole("button", { name: "关闭", exact: true }));
  expect(close).toHaveBeenCalledOnce(); first.unmount();
  render(element);
  expect(screen.getByRole("button", { name: "确认" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(outcome === "saved" ? "已保存" : "未确认");
  transport.load.mockResolvedValue(opened(outcome === "saved" ? [{ ...score, fileName: "新谱.pdf" }] : [score]));
  fireEvent.click(screen.getByRole("button", { name: "重新读取状态" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(request).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(outcome === "saved" ? 1 : 0);
});

it("waits for the departed dialog's pending write before rereading in a reopened action", async () => {
  const { library, transport, request, complete } = await setup();
  const response = deferred<Response>(); request.mockReturnValue(response.promise);
  const first = renderHook(() => useScoreFileAction(library, score, "rename", complete));
  let submission!: Promise<void>;
  await act(async () => { submission = first.result.current.submit("新谱"); });
  first.unmount();
  const reopened = renderHook(() => useScoreFileAction(library, score, "trash", complete));
  expect(reopened.result.current.blocked).toBe(true);
  const before = transport.load.mock.calls.length;
  let recovery!: Promise<void>;
  await act(async () => { recovery = reopened.result.current.retry(); });
  expect(transport.load).toHaveBeenCalledTimes(before);
  transport.load.mockResolvedValue(opened([{ ...score, fileName: "新谱.pdf" }]));
  await act(async () => { response.resolve(new Response(null, { status: 204 })); await submission; await recovery; });
  expect(complete).toHaveBeenCalledExactlyOnceWith("文件已重命名。");
  expect(request).toHaveBeenCalledTimes(1);
});
