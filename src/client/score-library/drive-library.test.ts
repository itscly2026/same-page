import { effectiveCapabilities, emptyPermissions, noCapabilities } from "../../shared/drive-permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveLibrary } from "./drive-library";
import { clearDriveLibraryCache, readDriveLibrary, readReturningDriveCacheOwner, rememberDriveLibrary } from "./drive-library-cache";
import { type DriveLibraryAccess, type DriveLibraryTransport } from "./drive-library-transport";
import * as directoryStorage from "./local-drive-directory";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { readLibraryView, rememberLibraryView } from "./library-view-state";

type Opened = Extract<DriveLibraryAccess, { kind: "opened" }>;
const owner = "user:one";
const choirId = "drive-one";
function opened(fileName = "秋日.pdf", canManage = true): Opened {
  return {
    kind: "opened", choir: { id: choirId, name: "排练云盘", guestAdmissionMode: "open" }, isMember: true,
    result: {
      scores: [{ id: "score-one", choirId, fileName, updatedAt: 1, currentVersion: {
        id: "version-one", versionNumber: 1, sizeBytes: 100, sha256: "a".repeat(64), etag: "one", pageCount: 1, createdAt: 1,
      } }],
      storage: { usedBytes: 100, limitBytes: 1000 }, permissions: { capabilities: canManage ? effectiveCapabilities(true, emptyPermissions(), emptyPermissions()) : noCapabilities() },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sessions: DriveLibrary[] = [];
function create(load: DriveLibraryTransport["load"], ownerKey: `user:${string}` | `guest:${string}` = owner, drive = choirId, authenticated = ownerKey.startsWith("user:")) {
  const transport = { load: vi.fn(load), join: vi.fn<DriveLibraryTransport["join"]>().mockResolvedValue(null) };
  const library = new DriveLibrary(ownerKey, drive, transport);
  sessions.push(library);
  library.setAuthenticated(authenticated);
  library.start();
  return { library, transport };
}
beforeEach(async () => { clearDriveLibraryCache(); window.sessionStorage.clear(); await localDatabase.open(); });
afterEach(() => { sessions.forEach(library => library.stop()); sessions.length = 0; vi.restoreAllMocks(); });

describe("DriveLibrary interface", () => {
  it("reopens its persisted directory without authority before the next remote response", async () => {
    await activateAuthenticatedLocalOwner("one");
    const { library: first } = create(async () => opened("本地.pdf"));
    await first.refresh();
    first.stop();
    clearDriveLibraryCache();
    const response = deferred<Opened>();
    const { library } = create(() => response.promise);
    await vi.waitFor(() => expect(library.getSnapshot().scores[0]?.fileName).toBe("本地.pdf"));
    expect(library.getSnapshot().access).toMatchObject({ local: true, isMember: false, result: { permissions: { capabilities: noCapabilities() } } });
    response.resolve(opened("远端.pdf"));
    await library.refresh();
    expect(library.getSnapshot().scores[0].fileName).toBe("远端.pdf");
    library.stop(); clearDriveLibraryCache();
    const { library: offline } = create(async () => opened(), owner, choirId, false);
    await offline.refresh();
    expect(offline.getSnapshot().scores[0].fileName).toBe("远端.pdf");
  });

  it("keeps view and position across local entry, confirmation and temporary failure", async () => {
    await activateAuthenticatedLocalOwner("one");
    const { library: first } = create(async () => opened());
    await first.refresh();
    first.prepareScoreOpen(320);
    first.stop();
    clearDriveLibraryCache();
    const { library, transport } = create(async () => opened(), owner, choirId, false);
    await library.refresh();
    expect(transport.load).not.toHaveBeenCalled();
    expect(library.getSnapshot().access).toMatchObject({ local: true, isMember: false });
    const scroll = vi.fn();
    library.restoreScroll(scroll);
    expect(scroll).toHaveBeenCalledWith(320);
    library.setSearch("秋日"); library.setSort("updated");
    library.setAuthenticated(true);
    await library.refresh();
    expect(library.getSnapshot().access).toMatchObject({ isMember: true, result: { permissions: { capabilities: opened().result.permissions.capabilities } } });
    transport.load.mockResolvedValueOnce({ kind: "failed" });
    await library.changed();
    expect(library.getSnapshot()).toMatchObject({ view: { search: "秋日", sort: "updated" }, access: { local: true, isMember: false, result: { permissions: { capabilities: noCapabilities() } } } });
    expect(library.getSnapshot().scores).toHaveLength(1);
    library.restoreScroll(scroll);
    expect(scroll).toHaveBeenCalledTimes(1);
    transport.load.mockResolvedValueOnce({ kind: "denied" });
    await library.changed();
    expect(library.getSnapshot().access.kind).toBe("denied");
    expect(library.getSnapshot().scores).toEqual([]);
  });

  it("persists confirmed removal and name without restoring retained copies", async () => {
    await activateAuthenticatedLocalOwner("one");
    const { library, transport } = create(async () => opened());
    await library.refresh();
    await localDatabase.offlineScores.put({ ...createLocalWorkspace(authenticatedLocalOwnerKey("one"), choirId, "score-one"), key: "retained", versionId: "version-one", fileName: "秋日.pdf", sha256: "unverified", pageCount: 1, blob: new Blob(["PDF"]), active: 1, verifiedAt: 1, annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
    await library.confirmRemoval("score-one");
    await library.confirmName("新云盘名称");
    transport.load.mockRejectedValueOnce(new TypeError("offline"));
    await library.changed();
    expect(library.getSnapshot().scores).toEqual([]);
    library.stop(); clearDriveLibraryCache();
    const { library: reopened } = create(async () => opened(), owner, choirId, false);
    await reopened.refresh();
    expect(reopened.getSnapshot()).toMatchObject({ scores: [], access: { choir: { name: "新云盘名称" } } });
    reopened.stop(); clearDriveLibraryCache();
    const empty = opened(); empty.result.scores = [];
    const { library: refreshed } = create(async () => empty);
    await refreshed.refresh();
    refreshed.stop(); clearDriveLibraryCache();
    const { library: offline } = create(async () => opened(), owner, choirId, false);
    await offline.refresh();
    expect(offline.getSnapshot().scores).toEqual([]);
  });

  it("does not persist a superseded response after stop or an owner round trip", async () => {
    await activateAuthenticatedLocalOwner("one");
    const { library: seed } = create(async () => opened("原目录.pdf"));
    await seed.refresh(); seed.stop(); clearDriveLibraryCache();
    const response = deferred<Opened>();
    const { library: stale, transport } = create(() => response.promise);
    const pending = stale.refresh();
    await vi.waitFor(() => expect(transport.load).toHaveBeenCalled());
    stale.stop(); clearDriveLibraryCache();
    await activateAuthenticatedLocalOwner("two");
    const { library: other } = create(async () => opened("另一人.pdf"), "user:two");
    await other.refresh(); other.stop(); clearDriveLibraryCache();
    await activateAuthenticatedLocalOwner("one");
    response.resolve(opened("迟到目录.pdf")); await pending;
    const { library } = create(async () => opened(), owner, choirId, false);
    await library.refresh();
    expect(library.getSnapshot().scores[0].fileName).toBe("原目录.pdf");
  });

  it("keeps successful online content usable when directory storage fails", async () => {
    await activateAuthenticatedLocalOwner("one");
    vi.spyOn(localDatabase.driveDirectories, "put").mockRejectedValue(new Error("quota"));
    const { library } = create(async () => opened());
    await library.refresh();
    expect(library.getSnapshot()).toMatchObject({ refreshMessage: null, access: { isMember: true } });
    expect(library.getSnapshot().scores[0].fileName).toBe("秋日.pdf");
  });

  it("revokes current authority immediately when authentication is lost", async () => {
    const { library } = create(async () => opened());
    await library.refresh();
    library.setAuthenticated(false);
    expect(library.getSnapshot().access).toMatchObject({ local: true, isMember: false, result: { permissions: { capabilities: noCapabilities() } } });
    await library.refresh();
  });

  it("cancels a pending name write when its lifetime stops", async () => {
    await activateAuthenticatedLocalOwner("one");
    const { library } = create(async () => opened());
    await library.refresh();
    const writing = library.confirmName("取消的名称").catch(() => undefined);
    library.stop();
    await writing;
    clearDriveLibraryCache();
    const { library: reopened } = create(async () => opened(), owner, choirId, false);
    await reopened.refresh();
    expect(reopened.getSnapshot().access).toMatchObject({ choir: { name: "排练云盘" } });
  });

  it("does not let a late local read reopen confirmed denial", async () => {
    await activateAuthenticatedLocalOwner("one");
    const { library: seed } = create(async () => opened());
    await seed.refresh(); seed.stop(); clearDriveLibraryCache();
    const saved = await directoryStorage.readLocalDriveDirectories("one");
    const local = deferred<typeof saved>();
    vi.spyOn(directoryStorage, "readLocalDriveDirectories").mockReturnValueOnce(local.promise);
    const { library } = create(async () => ({ kind: "denied" }));
    await library.refresh();
    local.resolve(saved);
    await local.promise;
    await Promise.resolve();
    expect(library.getSnapshot().access.kind).toBe("denied");
    expect(library.getSnapshot().scores).toEqual([]);
  });

  it("restores cached content without cached authority, then accepts current membership", async () => {
    rememberDriveLibrary(owner, choirId, opened());
    const response = deferred<Opened>();
    const { library } = create(() => response.promise);
    expect(library.getSnapshot().access).toMatchObject({ kind: "opened", isMember: false, result: { permissions: { capabilities: noCapabilities() } } });
    response.resolve(opened());
    await library.refresh();
    expect(library.getSnapshot().access).toMatchObject({ isMember: true, result: { permissions: { capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()) } } });
  });

  it("does not restore a confirmed deletion when the subsequent directory refresh fails", async () => {
    const { library, transport } = create(async () => opened());
    await library.refresh();
    await library.confirmRemoval("score-one");
    transport.load.mockRejectedValueOnce(new TypeError("offline"));
    await library.changed();
    expect(library.getSnapshot().scores).toEqual([]);
    expect(library.getSnapshot().refreshMessage).toContain("当前内容已保留");
  });

  it("keeps a guest's cached library available when session refresh is offline", async () => {
    rememberDriveLibrary("guest:drive-one", choirId, opened());
    const { library } = create(() => Promise.reject(new TypeError("offline")), "guest:drive-one");
    await library.refresh();
    expect(library.getSnapshot().scores).toHaveLength(1);
    expect(library.getSnapshot().refreshMessage).toContain("当前内容已保留");
  });

  it.each(["denied", "not-found"] as const)("clears cached authority and content after %s", async kind => {
    rememberDriveLibrary(owner, choirId, opened());
    const { library } = create(async () => ({ kind }));
    await library.refresh();
    expect(library.getSnapshot().access).toEqual({ kind });
    expect(library.getSnapshot().scores).toEqual([]);
    expect(readDriveLibrary(owner, choirId)).toBeNull();
  });

  it("coalesces foreground refreshes, but mutation refresh supersedes an old response", async () => {
    const first = deferred<Opened>();
    const { library, transport } = create(() => first.promise);
    const a = library.refresh(), b = library.refresh();
    expect(a).toBe(b);
    await Promise.resolve();
    expect(transport.load).toHaveBeenCalledTimes(1);
    const signal = transport.load.mock.calls[0][0];
    transport.load.mockResolvedValueOnce(opened("新文件名.pdf"));
    await library.changed();
    expect(signal.aborted).toBe(true);
    first.resolve(opened("旧文件名.pdf"));
    await a;
    expect(library.getSnapshot().scores[0].fileName).toBe("新文件名.pdf");
    expect(readDriveLibrary(owner, choirId)?.result.scores[0].fileName).toBe("新文件名.pdf");
  });

  it("does not let an older success resurrect a denied library", async () => {
    const first = deferred<Opened>();
    const { library, transport } = create(() => first.promise);
    const pending = library.refresh();
    await Promise.resolve();
    transport.load.mockResolvedValueOnce({ kind: "denied" });
    await library.changed();
    first.resolve(opened());
    await pending;
    expect(library.getSnapshot().access.kind).toBe("denied");
    expect(readDriveLibrary(owner, choirId)).toBeNull();
  });

  it("ignores stopped work, even when its adapter ignores cancellation", async () => {
    const first = deferred<Opened>();
    const { library, transport } = create(() => first.promise);
    const pending = library.refresh();
    await Promise.resolve();
    const listener = vi.fn(); library.subscribe(listener);
    library.stop();
    first.resolve(opened());
    await pending;
    expect(transport.load.mock.calls[0][0].aborted).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(readDriveLibrary(owner, choirId)).toBeNull();
  });

  it("fences a previous owner from network results and view writes after switching owners", async () => {
    const first = deferred<Opened>();
    const { library: old, transport } = create(() => first.promise);
    const pending = old.refresh();
    await Promise.resolve();
    const { library: current } = create(async () => opened("另一个用户.pdf"), "user:two");
    await current.refresh();
    old.setSearch("不可写入");
    first.resolve(opened("旧用户.pdf"));
    await pending;
    expect(transport.load.mock.calls[0][0].aborted).toBe(true);
    expect(readLibraryView(owner, choirId).search).toBe("");
    expect(readDriveLibrary("user:two", choirId)?.result.scores[0].fileName).toBe("另一个用户.pdf");
  });

  it("an explicit cache clear fences a pending response even for the same owner", async () => {
    const first = deferred<Opened>();
    const { library } = create(() => first.promise);
    const pending = library.refresh();
    await Promise.resolve();
    clearDriveLibraryCache();
    first.resolve(opened());
    await pending;
    expect(readDriveLibrary(owner, choirId)).toBeNull();
  });

  it("preserves edits to search and sort while the network is pending and writes each view once", async () => {
    const first = deferred<Opened>();
    const { library } = create(() => first.promise);
    const write = vi.spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem");
    library.setSearch("春日"); library.setSort("updated");
    first.resolve(opened("春日.pdf"));
    await library.refresh();
    expect(library.getSnapshot().view).toEqual({ search: "春日", sort: "updated" });
    expect(library.getSnapshot().scores).toHaveLength(1);
    expect(readLibraryView(owner, choirId)).toEqual({ ...library.getSnapshot().view, scrollTop: 0 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("restores position once after list commit and does not jump during background refresh", async () => {
    rememberLibraryView(owner, choirId, { search: "", sort: "name", scrollTop: 320 });
    rememberDriveLibrary(owner, choirId, opened());
    const first = deferred<Opened>();
    const { library } = create(() => first.promise);
    library.rememberScroll(0);
    const scroll = vi.fn();
    library.restoreScroll(scroll);
    expect(scroll).toHaveBeenCalledWith(320);
    library.rememberScroll(640);
    first.resolve(opened());
    await library.refresh();
    library.restoreScroll(scroll);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(readLibraryView(owner, choirId).scrollTop).toBe(640);
    library.prepareScoreOpen(720);
    expect(readLibraryView(owner, choirId).scrollTop).toBe(720);
    expect(readReturningDriveCacheOwner(choirId)).toBe(owner);
  });

  it("starts a clean request when React reconnects the same lifetime", async () => {
    const first = deferred<Opened>();
    const { library, transport } = create(() => first.promise);
    const pending = library.refresh();
    await Promise.resolve();
    library.stop();
    transport.load.mockResolvedValueOnce(opened("重连.pdf"));
    library.start();
    await library.refresh();
    first.resolve(opened("迟到.pdf"));
    await pending;
    expect(library.getSnapshot().scores[0].fileName).toBe("重连.pdf");
  });

  it("retries an initial failure and refreshes after successful admission", async () => {
    const { library, transport } = create(async () => ({ kind: "failed" }));
    await library.refresh();
    expect(library.getSnapshot().access.kind).toBe("failed");
    transport.load.mockResolvedValueOnce({ kind: "join-required", choir: opened().choir });
    await library.refresh();
    expect(library.getSnapshot().access.kind).toBe("join-required");
    transport.join.mockResolvedValueOnce("该成员关系需要云盘管理员恢复。");
    await library.join("小花");
    expect(library.getSnapshot().joinMessage).toContain("管理员恢复");
    transport.load.mockResolvedValueOnce(opened());
    await library.join("小花");
    expect(library.getSnapshot()).toMatchObject({ joining: false, joinMessage: null, access: { kind: "opened", isMember: true } });
    expect(transport.load.mock.lastCall?.[1]).toBe(false);
  });
});
