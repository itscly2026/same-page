import { effectiveCapabilities, emptyPermissions, noCapabilities } from "../../shared/drive-permissions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveLibrary } from "./drive-library";
import { clearDriveLibraryCache, readDriveLibrary, readReturningDriveCacheOwner, rememberDriveLibrary } from "./drive-library-cache";
import { type DriveLibraryAccess, type DriveLibraryTransport } from "./drive-library-transport";
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
function create(load: DriveLibraryTransport["load"], ownerKey: `user:${string}` | `guest:${string}` = owner, drive = choirId) {
  const transport = { load: vi.fn(load), join: vi.fn<DriveLibraryTransport["join"]>().mockResolvedValue(null) };
  const library = new DriveLibrary(ownerKey, drive, transport);
  sessions.push(library);
  library.start();
  return { library, transport };
}
beforeEach(() => { clearDriveLibraryCache(); window.sessionStorage.clear(); });
afterEach(() => { sessions.forEach(library => library.stop()); sessions.length = 0; vi.restoreAllMocks(); });

describe("DriveLibrary interface", () => {
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
