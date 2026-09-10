import { NAVIGATION_FRESH_MS, onDriveChange } from "../settings/navigation-events";
import { revokeDriveReadResources, type ReadState } from "../settings/read-resource";
import { localDatabase } from "../platform/local-database";
import { liveQuery } from "dexie";
import { readRetainedScores } from "../offline/retained-scores";
import { captureLocalWorkspaceSession, createLocalWorkspace, currentLocalOwnerKey, authenticatedLocalOwnerKey, type LocalWorkspace } from "../platform/local-workspace";
import { readLocalDriveDirectories, rememberLocalDriveDirectory, rememberDriveAccessRevoked, renameLocalDriveDirectory, removeLocalDriveScore } from "./local-drive-directory";
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
  reading: Pick<ReadState<never>, "request" | "authority">;
  access: DriveLibraryAccess;
  view: Pick<LibraryView, "search" | "sort">;
  scores: ScoreSummary[];
  refreshMessage: string | null;
  joinMessage: string | null;
  joining: boolean;
}

type OpenedAccess = Extract<DriveLibraryAccess, { kind: "opened" }>;

function localAccess(access: OpenedAccess): OpenedAccess {
  return { ...access, local: true, isMember: false, rememberedMembership: access.isMember || access.rememberedMembership,
    rememberedCapabilities: access.local ? access.rememberedCapabilities : access.result.permissions.capabilities,
    managementVisible: access.managementVisible || hasManagement(access.result.permissions.capabilities),
    result: { ...access.result, permissions: { capabilities: noCapabilities() } },
  };
}

const refreshFailed = "暂时无法更新乐谱列表，当前内容已保留。请稍后重试。";

// One lifetime owns local/remote directory ordering, persistence, authority and view.
// The React adapter only supplies browser events and committed-list scrolling.
export class DriveLibrary {
  private retainedSubscription: { unsubscribe(): void } | null = null;
  private authenticated = false;
  private confirmedAt = -Infinity;
  private stopObserving: (() => void) | null = null;
  setAuthenticated(value: boolean) {
    if (this.authenticated === value) return;
    this.authenticated = value;
    if (!value) {
      invalidateDriveLibrary(this.ownerKey, this.choirId);
      this.confirmedAt = -Infinity;
      if (this.snapshot.access.kind === "opened") this.publish({ access: localAccess(this.snapshot.access), reading: { request: "idle", authority: "unconfirmed" } });
    }
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
      reading: { request: "idle", authority: "unconfirmed" },
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
    this.view = readLibraryView(this.ownerKey, this.choirId);
    this.restorePending = true;
    this.lifetimeController = new AbortController();
    this.ownerSignal = AbortSignal.any([captureDriveLibraryOwner(this.ownerKey), this.lifetimeController.signal]);
    this.workspace = this.ownerKey.startsWith("user:")
      ? captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(this.ownerKey.slice(5)), this.choirId, "")).catch(() => null)
      : currentLocalOwnerKey().then(owner => owner?.startsWith("guest:") ? captureLocalWorkspaceSession(createLocalWorkspace(owner, this.choirId, "")) : null).catch(() => null);
    this.stopObserving = onDriveChange((driveId, permissions, resource) => {
      if ((resource === "display-name" && !permissions) || driveId !== this.choirId) return;
      this.confirmedAt = -Infinity;
      this.request?.controller.abort(); this.request = null;
      this.publish({ reading: { ...this.snapshot.reading, request: "idle" } });
      if (permissions && this.snapshot.access.kind === "opened") this.publish({ access: localAccess(this.snapshot.access), reading: { request: "idle", authority: "unconfirmed" } });
    });
    const cached = readDriveLibrary(this.ownerKey, this.choirId);
    const confirmed = Boolean(cached && (this.authenticated || this.ownerKey.startsWith("guest:")));
    this.confirmedAt = confirmed ? cached!.updatedAt : -Infinity;
    this.publish({
      view: { search: this.view.search, sort: this.view.sort },
      reading: { request: "idle", authority: confirmed ? "confirmed" : "unconfirmed" },
      access: cached
        ? (confirmed ? { kind: "opened", choir: cached.choir, result: cached.result, isMember: cached.isMember ?? false } : localAccess({ kind: "opened", choir: cached.choir, result: cached.result, isMember: cached.isMember ?? false }))
        : { kind: "loading", choir: readDriveSummary(this.ownerKey, this.choirId) ?? undefined },
    });
    this.localController = new AbortController();
    const signal = AbortSignal.any([this.ownerSignal, this.localController.signal]);
    void this.readLocal(signal).then(access => {
      if (signal.aborted || !access || !["loading", "failed"].includes(this.snapshot.access.kind)) return;
      this.publish({ access });
    }).catch(() => undefined);
    void this.refreshIfStale();
  };

  stop = () => {
    this.active = false;
    this.stopObserving?.(); this.stopObserving = null;
    this.retainedSubscription?.unsubscribe();
    this.retainedSubscription = null;
    this.lifetimeController.abort();
    this.localController?.abort();
    this.request?.controller.abort();
    this.request = null;
    this.joinController?.abort();
    this.joinController = null;
  };

  whenSettled = () => this.request?.done ?? Promise.resolve();

  refreshIfStale = () => Date.now() - this.confirmedAt < NAVIGATION_FRESH_MS ? Promise.resolve() : this.refresh();

  refresh = () => this.load(this.snapshot.access.kind !== "opened");

  changed = () => {
    if (!this.isActive()) return Promise.resolve();
    invalidateDriveLibrary(this.ownerKey, this.choirId);
    this.confirmedAt = -Infinity;
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
    rememberDriveLibrary(this.ownerKey, this.choirId, access, this.confirmedAt);
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
    rememberDriveLibrary(this.ownerKey, this.choirId, access, this.confirmedAt);
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
    this.publish({ reading: { ...this.snapshot.reading, request: "pending" } });
    pending.done = Promise.resolve().then(() => {
      signal.throwIfAborted();
      if (!authenticated && this.ownerKey.startsWith("user:") && this.snapshot.access.kind === "opened" && this.snapshot.access.retained) return this.snapshot.access;
      if (!authenticated && this.ownerKey.startsWith("user:")) return this.readLocal(signal);
      return this.transport.load(signal, allowAdmission, authenticated);
    })
      .then(async (access) => {
        if (this.request !== pending || !this.isActive() || controller.signal.aborted) return;
        if (!access || access.kind === "failed") {
          await this.failed(signal, access?.kind === "failed" && access.authenticationRequired);
          return;
        }
        if (access.kind === "opened" && !access.local) {
          const captured = await workspace;
          if (captured) await rememberLocalDriveDirectory(captured, access.choir, access.result.scores, signal, access.isMember && !access.choir.isPreviewEntry, access.result.permissions.capabilities, access.result.storage).catch(() => undefined);
        }
        if (this.request !== pending || signal.aborted) return;
        if (access.kind === "opened") {
          if (!access.local) { this.confirmedAt = Date.now(); rememberDriveLibrary(this.ownerKey, this.choirId, access, this.confirmedAt); }
        } else {
          invalidateDriveLibrary(this.ownerKey, this.choirId);
        }
        this.publish({ reading: { request: "pending", authority: access.kind === "denied" || access.kind === "not-found" ? "revoked" : access.kind === "opened" && !access.local ? "confirmed" : "unconfirmed" } });
        this.localController?.abort();
        if (access.kind === "denied" || access.kind === "not-found") {
          revokeDriveReadResources(this.choirId);
          this.publish({ access: this.retainedAccess([]), refreshMessage: null });
          const captured = await workspace;
          if (captured) await rememberDriveAccessRevoked(captured, signal).catch(() => undefined);
          const scores = captured ? await readRetainedScores(captured).catch(() => []) : [];
          if (signal.aborted) return;
          const retained = this.retainedAccess(scores);
          this.publish({ access: retained, refreshMessage: null });
          this.watchRetained(captured, ownerSignal);
        } else {
          if (access.kind === "opened" && !access.retained) {
            this.retainedSubscription?.unsubscribe(); this.retainedSubscription = null;
          }
          if (access.kind === "opened" && access.retained) this.watchRetained(await workspace, ownerSignal);
          this.publish({ access, refreshMessage: null });
        }
      })
      .catch(async () => {
        if (this.request === pending && !controller.signal.aborted) await this.failed(signal);
      })
      .finally(() => { if (this.request === pending) { this.request = null; this.publish({ reading: { ...this.snapshot.reading, request: "idle" } }); } });
    return pending.done;
  }

  private retainedAccess(scores: ScoreSummary[]): OpenedAccess {
    return { kind: "opened", local: true, retained: true, isMember: false,
      choir: { id: this.choirId, name: "本机保留的乐谱", guestAdmissionMode: "invite" },
      result: { scores, permissions: { capabilities: noCapabilities() }, storage: { usedBytes: 0, limitBytes: 1 } } };
  }

  private watchRetained(captured: LocalWorkspace | null, ownerSignal: AbortSignal) {
    this.retainedSubscription?.unsubscribe();
    if (captured) this.retainedSubscription = liveQuery(() => readRetainedScores(captured)).subscribe({
      next: scores => {
        const current = this.snapshot.access;
        if (!ownerSignal.aborted && current.kind === "opened" && current.retained) this.publish({ access: { ...current, result: { ...current.result, scores } } });
      },
      error: () => {
        const current = this.snapshot.access;
        if (!ownerSignal.aborted && current.kind === "opened" && current.retained) this.publish({ access: { ...current, result: { ...current.result, scores: [] } }, refreshMessage: "无法读取本机副本，请重试。" });
      },
    });
  }

  private async readLocal(signal: AbortSignal): Promise<OpenedAccess | null> {
    const captured = await this.workspace;
    const directory = this.ownerKey.startsWith("user:")
      ? (await readLocalDriveDirectories(this.ownerKey.slice(5))).find(entry => entry.choirId === this.choirId)
      : captured ? await localDatabase.driveDirectories.get(JSON.stringify([captured.ownerKey, this.choirId])) : null;
    signal.throwIfAborted();
    if (directory?.accessRevoked && captured) return this.retainedAccess(await readRetainedScores(captured));
    if (!this.ownerKey.startsWith("user:")) return null;
    return { kind: "opened", local: true, isMember: false,
      rememberedMembership: directory?.membership ?? false,
      managementVisible: hasManagement(directory?.capabilities ?? noCapabilities()), rememberedCapabilities: directory?.capabilities,
      choir: directory?.choir ?? readDriveSummary(this.ownerKey, this.choirId) ?? { id: this.choirId, name: "云盘", guestAdmissionMode: "invite" },
      result: { scores: directory?.scores ?? [], storage: directory?.storage ?? { usedBytes: 0, limitBytes: 1 }, permissions: { capabilities: noCapabilities() } },
    };
  }

  private async failed(signal: AbortSignal, authenticationRequired = false) {
    this.confirmedAt = -Infinity;
    const current = this.snapshot.access;
    if (current.kind === "opened") {
      if (authenticationRequired) {
        invalidateDriveLibrary(this.ownerKey, this.choirId);
        this.publish({ access: localAccess(current), reading: { request: "pending", authority: "signed-out" }, refreshMessage: "登录已失效，请重新登录后再试。" });
      } else {
        if (!current.local) rememberDriveLibrary(this.ownerKey, this.choirId, current, -Infinity);
        this.publish({ refreshMessage: refreshFailed });
      }
      return;
    }
    const local = await this.readLocal(signal).catch(() => null);
    if (signal.aborted) return;
    this.publish({ access: local ?? { kind: "opened", local: true, isMember: false,
      choir: readDriveSummary(this.ownerKey, this.choirId) ?? { id: this.choirId, name: "云盘", guestAdmissionMode: "invite" },
      result: { scores: [], permissions: { capabilities: noCapabilities() }, storage: { usedBytes: 0, limitBytes: 1 } } }, refreshMessage: refreshFailed });
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
