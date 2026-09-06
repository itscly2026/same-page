import type { ScoreSummary } from "../../shared/scores";
import {
  captureDriveLibraryOwner, invalidateDriveLibrary, prepareDriveLibraryReturn,
  readDriveLibrary, readDriveSummary, rememberDriveLibrary,
  type DriveCacheOwnerKey,
} from "./drive-library-cache";
import { readLibraryView, rememberLibraryView, selectLibraryScores, type LibrarySort, type LibraryView } from "./library-view-state";
import { driveLibraryTransport, type DriveLibraryAccess, type DriveLibraryTransport } from "./drive-library-transport";

export interface DriveLibrarySnapshot {
  access: DriveLibraryAccess;
  view: Pick<LibraryView, "search" | "sort">;
  scores: ScoreSummary[];
  refreshMessage: string | null;
  joinMessage: string | null;
  joining: boolean;
}

const refreshFailed = "暂时无法更新乐谱列表，当前内容已保留。请稍后重试。";

// One lifetime owns the library's network ordering, cache authority and view.
// The React adapter only supplies browser events and committed-list scrolling.
export class DriveLibrary {
  private snapshot: DriveLibrarySnapshot;
  private view: LibraryView;
  private listeners = new Set<() => void>();
  private active = false;
  private ownerSignal = AbortSignal.abort();
  private request: { controller: AbortController; done: Promise<void> } | null = null;
  private joinController: AbortController | null = null;
  private restorePending = true;
  private localController: AbortController | null = null;

  constructor(
    private ownerKey: DriveCacheOwnerKey,
    private choirId: string,
    private transport: DriveLibraryTransport = driveLibraryTransport(choirId, ownerKey.startsWith("user:")),
  ) {
    this.view = readLibraryView(ownerKey, choirId);
    this.snapshot = {
      access: { kind: "loading" }, view: { search: this.view.search, sort: this.view.sort }, scores: [],
      refreshMessage: null, joinMessage: null, joining: false,
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start = () => {
    if (this.active) return;
    this.active = true;
    this.ownerSignal = captureDriveLibraryOwner(this.ownerKey);
    const cached = readDriveLibrary(this.ownerKey, this.choirId);
    this.publish({
      access: cached
        ? { kind: "opened", choir: cached.choir, result: { ...cached.result, permissions: { canManage: false } }, isMember: false, local: true, managementVisible: cached.result.permissions.canManage }
        : { kind: "loading", choir: readDriveSummary(this.ownerKey, this.choirId) ?? undefined },
    });
    this.localController = new AbortController();
    const signal = AbortSignal.any([this.ownerSignal, this.localController.signal]);
    void this.transport.readLocal?.(signal).then(access => {
      if (signal.aborted || !access || !["loading", "failed"].includes(this.snapshot.access.kind)) return;
      this.publish({ access });
    }).catch(() => undefined);
    void this.load(true);
  };

  stop = () => {
    this.active = false;
    this.localController?.abort();
    this.request?.controller.abort();
    this.request = null;
    this.joinController?.abort();
    this.joinController = null;
  };

  refresh = () => this.load(this.snapshot.access.kind !== "opened");

  changed = () => {
    if (!this.isActive()) return Promise.resolve();
    invalidateDriveLibrary(this.ownerKey, this.choirId);
    this.request?.controller.abort();
    this.request = null;
    return this.load(false);
  };

  setSearch = (search: string) => this.updateView({ search, scrollTop: 0 });
  setSort = (sort: LibrarySort) => this.updateView({ sort });
  rememberScroll = (scrollTop: number) => {
    // Scroll events during a pending DOM restore must not erase its target.
    if (this.restorePending) return;
    this.updateView({ scrollTop });
  };
  prepareScoreOpen = (scrollTop: number) => {
    if (!this.isActive()) return;
    this.restorePending = false;
    this.updateView({ scrollTop });
    prepareDriveLibraryReturn(this.ownerKey, this.choirId);
  };
  restoreScroll = (apply: (scrollTop: number) => void) => {
    if (!this.isActive() || !this.restorePending || this.snapshot.access.kind !== "opened") return;
    this.restorePending = false;
    apply(this.view.scrollTop);
  };

  join = async (displayName: string) => {
    if (!this.isActive() || this.snapshot.joining) return;
    const controller = new AbortController();
    this.joinController = controller;
    this.publish({ joining: true, joinMessage: null });
    try {
      const message = await this.transport.join(displayName, AbortSignal.any([controller.signal, this.ownerSignal]));
      if (!this.isActive() || controller.signal.aborted) return;
      this.publish({ joinMessage: message });
      if (!message) await this.changed();
    } catch {
      if (!controller.signal.aborted) this.publish({ joinMessage: "暂时无法加入这个云盘，请稍后再试。" });
    } finally {
      if (this.joinController === controller) {
        this.joinController = null;
        this.publish({ joining: false });
      }
    }
  };

  private load(allowAdmission: boolean): Promise<void> {
    if (!this.isActive()) return Promise.resolve();
    if (this.request) return this.request.done;
    const controller = new AbortController();
    // Register before calling the adapter, including an adapter that throws.
    const ownerSignal = this.ownerSignal;
    const pending = { controller, done: Promise.resolve() };
    this.request = pending;
    pending.done = Promise.resolve().then(() => {
      const signal = AbortSignal.any([controller.signal, ownerSignal]);
      signal.throwIfAborted();
      return this.transport.load(signal, allowAdmission);
    })
      .then((access) => {
        if (this.request !== pending || !this.isActive() || controller.signal.aborted) return;
        if (access.kind === "failed") {
          this.failed();
          return;
        }
        if (access.kind === "opened") {
          if (!access.local) rememberDriveLibrary(this.ownerKey, this.choirId, access);
        } else {
          invalidateDriveLibrary(this.ownerKey, this.choirId);
        }
        this.publish({ access, refreshMessage: null });
      })
      .catch(() => {
        if (this.request === pending && !controller.signal.aborted) this.failed();
      })
      .finally(() => { if (this.request === pending) this.request = null; });
    return pending.done;
  }

  private failed() {
    this.publish(this.snapshot.access.kind === "opened"
      ? { access: { ...this.snapshot.access, local: true, managementVisible: this.snapshot.access.managementVisible || this.snapshot.access.result.permissions.canManage, result: { ...this.snapshot.access.result, permissions: { canManage: false } } }, refreshMessage: refreshFailed }
      : { access: { kind: "failed" }, refreshMessage: null });
  }

  private updateView(update: Partial<LibraryView>) {
    if (!this.isActive()) return;
    const view = { ...this.view, ...update };
    const previous = this.view;
    if (view.search === previous.search && view.sort === previous.sort && view.scrollTop === previous.scrollTop) return;
    rememberLibraryView(this.ownerKey, this.choirId, view);
    this.view = view;
    if (view.search !== previous.search || view.sort !== previous.sort) {
      this.publish({ view: { search: view.search, sort: view.sort } });
    }
  }

  private isActive() { return this.active && !this.ownerSignal.aborted; }

  private publish(update: Partial<DriveLibrarySnapshot>) {
    if (!this.isActive()) return;
    const next = { ...this.snapshot, ...update };
    if (update.access || update.view) {
      next.scores = next.access.kind === "opened"
        ? selectLibraryScores(next.access.result.scores, next.view.search, next.view.sort, this.ownerKey, this.choirId)
        : [];
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
