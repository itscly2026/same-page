// Navigation caches are scoped to one effective online session, independently
// from the device's offline owner. No server authorization is cached here.
export const NAVIGATION_FRESH_MS = 60_000;
const resets = new Set<() => void>();
const changes = new Set<(driveId: string, permissions: boolean, resource: string) => void>();
let session: string | null | undefined;
let epoch = 0;
export const captureNavigationIdentity = () => { const captured = epoch; return () => captured === epoch; };
export function onNavigationReset(listener: () => void) { resets.add(listener); }
export function onDriveChange(listener: (driveId: string, permissions: boolean, resource: string) => void) { changes.add(listener); return () => { changes.delete(listener); }; }
export function invalidateNavigationDrive(driveId: string, permissions = false, resource = "*") { for (const listener of changes) listener(driveId, permissions, resource); }
export function resetNavigation() { epoch++; for (const listener of resets) listener(); }
export function observeNavigationSession(next: string | null) {
  if (session === next) return;
  session = next;
  resetNavigation();
}
export function observeNavigationResponse(input: RequestInfo | URL, init: RequestInit | undefined, response: Response) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, "https://same-page.invalid").pathname;
  const match = /^\/api\/choirs\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const permissions = response.status === 401 || response.status === 403;
  // Reads retain their endpoint-specific denial semantics; a failed mutation
  // invalidates remembered capabilities, without declaring the drive deleted.
  if (method === "GET" || method === "HEAD" || (!response.ok && !permissions)) return;
  const resource = match[2];
  if (/^scores\/[^/]+\/(annotations|layers|preferences)(\/|$)/.test(resource)) return;
  if (!/^(name|display-name|memberships|ownership|shared-layers|scores|purge)(\/|$)/.test(resource)) return;
  invalidateNavigationDrive(match[1], permissions || /^(memberships|ownership)(\/|$)/.test(resource), resource);
}

export function affectsReadResource(key: string, resource: string, permissions: boolean) {
  if (permissions || resource === "*" || resource === "purge") return true;
  const kind = resource.split("/")[0];
  const parts = key.split(":");
  const targets: Record<string, string[]> = {
    scores: ["usage"],
    name: ["settings", "management"],
    "display-name": ["settings", "permission-contacts", "memberships"],
    "shared-layers": ["management", "shared-layers", "shared-layer", "layer-access", "reading-defaults"],
  };
  return (targets[kind] ?? []).some(target => parts.includes(target));
}
