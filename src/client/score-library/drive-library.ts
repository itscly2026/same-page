import { captureLocalWorkspaceSession, createLocalWorkspace, authenticatedLocalOwnerKey, type LocalWorkspace } from "../platform/local-workspace";
import { readLocalDriveDirectories, rememberLocalDriveDirectory, renameLocalDriveDirectory, removeLocalDriveScore } from "./local-drive-directory";
import { noCapabilities, hasManagement } from "../../shared/drive-permissions";
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

type OpenedAccess = Extract<DriveLibraryAccess, { kind: "opened" }>;

function localAccess(access: OpenedAccess): OpenedAccess {
  return { ...access, local: true, isMember: false,
    rememberedCapabilities: access.local ? access.rememberedCapabilities : access.result.permissions.capabilities,
    managementVisible: access.managementVisible || hasManagement(access.result.permissions.capabilities),
    result: { ...access.result, permissions: { capabilities: noCapabilities() } },
  };
}

const refreshFailed = "暂时无法更新乐谱列表，当前内容已保留。请稍后重试。";

// One lifetime owns local/remote directory ordering, persistence, authority and view.
// The React adapter only supplies browser events and committed-list scrolling.
export class DriveLibrary {
  private authenticated = false;
  setAuthenticated(value: boolean) {
    if (this.authenticated === value) return;
    this.authenticated = value;
    if (!value && this.snapshot.access.kind === "opened") this.publish({ access: localAccess(this.snapshot.access) });
    if (this.active) void this.changed();
  }
  private snapshot: DriveLibrarySnapshot;
  private view: LibraryView;
  private listeners = new Set<() => void>();
  private active = false;
  private lifetimeController = new AbortController();
  private ownerSignal = AbortSignal.abort();
  private request: { controller: AbortController; done: Promise<void> } | null = null;
  private joinController: AbortController | null = null;
  private restorePending = true;
  private localController: AbortController | null = null;
  private workspace: Promise<LocalWorkspace | null> = Promise.resolve(null);

  constructor(
    private ownerKey: DriveCacheOwnerKey,
    private choirId: string,
    private transport: DriveLibraryTransport = driveLibraryTransport(choirId),
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
    this.lifetimeController = new AbortController();
    this.ownerSignal = AbortSignal.any([captureDriveLibraryOwner(this.ownerKey), this.lifetimeController.signal]);
    this.workspace = this.ownerKey.startsWith("user:")
      ? captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(this.ownerKey.slice(5)), this.choirId, "")).catch(() => null)
      : Promise.resolve(null);
    const cached = readDriveLibrary(this.ownerKey, this.choirId);
    this.publish({
      access: cached
        ? localAccess({ kind: "opened", choir: cached.choir, result: cached.result, isMember: false })
        : { kind: "loading", choir: readDriveSummary(this.ownerKey, this.choirId) ?? undefined },
    });
    this.localController = new AbortController();
    const signal = AbortSignal.any([this.ownerSignal, this.localController.signal]);
    void this.readLocal(signal).then(access => {
      if (signal.aborted || !access || !["loading", "failed"].includes(this.snapshot.access.kind)) return;
      this.publish({ access });
    }).catch(() => undefined);
    void this.load(true);
  };

  stop = () => {
    this.active = false;
    this.lifetimeController.abort();
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

  confirmRemoval = async (scoreId: string) => {
    if (!this.isActive() || this.snapshot.access.kind !== "opened") return;
    this.request?.controller.abort();
    this.request = null;
    this.localController?.abort();
    const access = { ...this.snapshot.access, result: { ...this.snapshot.access.result, scores: this.snapshot.access.result.scores.filter(score => score.id !== scoreId) } };
    rememberDriveLibrary(this.ownerKey, this.choirId, access);
    this.publish({ access });
    const signal = this.ownerSignal;
    const workspace = await this.workspace;
    if (workspace) await removeLocalDriveScore(workspace, scoreId, signal);
  };

  confirmName = async (name: string) => {
    if (!this.isActive() || this.snapshot.access.kind !== "opened") return;
    this.request?.controller.abort();
    this.request = null;
    this.localController?.abort();
    const access = { ...this.snapshot.access, choir: { ...this.snapshot.access.choir, name } };
    rememberDriveLibrary(this.ownerKey, this.choirId, access);
    this.publish({ access });
    const signal = this.ownerSignal;
    const workspace = await this.workspace;
    if (workspace) await renameLocalDriveDirectory(workspace, name, signal);
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
    const workspace = this.workspace;
    const authenticated = this.authenticated;
    const signal = AbortSignal.any([controller.signal, ownerSignal]);
    const pending = { controller, done: Promise.resolve() };
    this.request = pending;
    pending.done = Promise.resolve().then(() => {
      signal.throwIfAborted();
      if (!authenticated && this.ownerKey.startsWith("user:")) return this.readLocal(signal);
      return this.transport.load(signal, allowAdmission, authenticated);
    })
      .then(async (access) => {
        if (this.request !== pending || !this.isActive() || controller.signal.aborted) return;
        if (!access || access.kind === "failed") {
          this.failed();
          return;
        }
        if (access.kind === "opened") {
          if (!access.local) rememberDriveLibrary(this.ownerKey, this.choirId, access);
        } else {
          invalidateDriveLibrary(this.ownerKey, this.choirId);
        }
        this.localController?.abort();
        this.publish({ access, refreshMessage: null });
        if (access.kind === "opened" && !access.local) {
          const captured = await workspace;
          if (captured) await rememberLocalDriveDirectory(captured, access.choir, access.result.scores, signal, access.isMember && !access.choir.isPreviewEntry, access.result.permissions.capabilities, access.result.storage).catch(() => undefined);
        }
      })
      .catch(() => {
        if (this.request === pending && !controller.signal.aborted) this.failed();
      })
      .finally(() => { if (this.request === pending) this.request = null; });
    return pending.done;
  }

  private async readLocal(signal: AbortSignal): Promise<OpenedAccess | null> {
    if (!this.ownerKey.startsWith("user:")) return null;
    const directory = (await readLocalDriveDirectories(this.ownerKey.slice(5))).find(entry => entry.choirId === this.choirId);
    signal.throwIfAborted();
    return { kind: "opened", local: true, isMember: false,
      rememberedMembership: directory?.membership ?? false,
      managementVisible: hasManagement(directory?.capabilities ?? noCapabilities()), rememberedCapabilities: directory?.capabilities,
      choir: directory?.choir ?? readDriveSummary(this.ownerKey, this.choirId) ?? { id: this.choirId, name: "云盘", guestAdmissionMode: "invite" },
      result: { scores: directory?.scores ?? [], storage: directory?.storage ?? { usedBytes: 0, limitBytes: 1 }, permissions: { capabilities: noCapabilities() } },
    };
  }

  private failed() {
    this.publish(this.snapshot.access.kind === "opened"
      ? { access: localAccess(this.snapshot.access), refreshMessage: refreshFailed }
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
