import { onReaderIdentityChange } from "../reader/reader-cache-events";
import { affectsReadResource, onDriveChange, onNavigationReset } from "./navigation-events";
import { SettingsRequestError } from "./settings-request";

export type ReadState<T> = { data: T | null; request: "idle" | "pending"; authority: "unconfirmed" | "confirmed" | "signed-out" | "revoked"; error: unknown };
let epoch = 0;
export const captureReadIdentity = () => { const captured = epoch; return () => captured === epoch; };

export class ReadResource<T> {
  private state: ReadState<T> = { data: null, request: "idle", authority: "unconfirmed", error: null };
  private confirmedAt = -Infinity;
  private pending: { controller: AbortController; done: Promise<void> } | null = null;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get observed() { return this.listeners.size > 0; }
  fresh(staleTime: number) { return this.state.authority === "confirmed" && Date.now() - this.confirmedAt < staleTime; }
  private publish(state: ReadState<T>) { this.state = state; for (const listener of this.listeners) listener(); }
  invalidate = (dropAuthority = false) => {
    this.pending?.controller.abort(); this.pending = null; this.confirmedAt = -Infinity;
    this.publish({ ...this.state, request: "idle", authority: dropAuthority && this.state.authority === "confirmed" ? "unconfirmed" : this.state.authority });
  };
  clear = () => { this.invalidate(true); this.publish({ data: null, request: "idle", authority: "revoked", error: null }); };
  restore(data: T) { if (!this.state.data && this.state.authority === "unconfirmed") this.publish({ ...this.state, data }); }
  private accept(data: T, confirmedAt: number) {
    this.invalidate(); this.confirmedAt = confirmedAt;
    this.publish({ data, request: "idle", authority: "confirmed", error: null });
  }
  confirm = (data: T) => this.accept(data, Date.now());
  update = (data: T) => this.accept(data, this.confirmedAt);
  read(load: (signal: AbortSignal) => Promise<T>, staleTime = 0): Promise<void> {
    if (this.pending) return this.pending.done;
    if (this.fresh(staleTime)) return Promise.resolve();
    const controller = new AbortController();
    const currentIdentity = captureReadIdentity();
    const pending = { controller, done: Promise.resolve() };
    this.pending = pending;
    const current = () => this.pending === pending && !controller.signal.aborted && currentIdentity();
    this.publish({ ...this.state, request: "pending", error: null });
    pending.done = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return load(controller.signal); }).then(data => {
      if (!current()) return;
      this.confirmedAt = Date.now();
      this.publish({ data, request: "idle", authority: "confirmed", error: null });
    }).catch(error => {
      if (!current()) return;
      this.confirmedAt = -Infinity;
      this.publish(failedRead(this.state, error));
      throw error;
    }).finally(() => { if (this.pending === pending) this.pending = null; });
    return pending.done;
  }
}

const resources = new Map<string, ReadResource<unknown>>();
export function getReadResource<T>(key: string): ReadResource<T> {
  let resource = resources.get(key);
  if (!resource) {
    resource = new ReadResource();
    resources.set(key, resource);
  }
  if (resources.size > 40) {
    for (const [oldKey, old] of resources) {
      if (oldKey !== key && !old.observed) { old.clear(); resources.delete(oldKey); break; }
    }
  }
  return resource as ReadResource<T>;
}
export function clearReadResources() { epoch++; for (const resource of resources.values()) resource.clear(); resources.clear(); }
onReaderIdentityChange(clearReadResources);
onNavigationReset(clearReadResources);
onDriveChange((driveId, permissions, changedResource) => {
  for (const [key, resource] of resources) if (key.split(":").includes(driveId) && affectsReadResource(key, changedResource, permissions)) resource.invalidate(permissions);
});
export function revokeDriveReadResources(driveId: string) {
  for (const [key, resource] of resources) if (key.split(":").includes(driveId)) resource.clear();
}
export function readResource<T>(key: string): T | null { return getReadResource<T>(key).getSnapshot().data; }
export function rememberResource<T>(key: string, data: T) { getReadResource<T>(key).restore(data); }
export function failedRead<T>(previous: ReadState<T>, error: unknown): ReadState<T> {
  const status = error instanceof SettingsRequestError ? error.status : null;
  const authority = status === 401 ? "signed-out" : status === 403 || status === 404 ? "revoked" : previous.authority;
  return { data: authority === "signed-out" || authority === "revoked" ? null : previous.data, request: "idle", authority, error };
}
