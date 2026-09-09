import { onReaderIdentityChange } from "../reader/reader-cache-events";
import { SettingsRequestError } from "./settings-request";

export type ReadState<T> = { data: T | null; request: "idle" | "pending"; authority: "unconfirmed" | "confirmed" | "signed-out" | "revoked"; error: unknown };
const resources = new Map<string, unknown>();
let epoch = 0;
export function clearReadResources() { epoch++; resources.clear(); }
onReaderIdentityChange(clearReadResources);
export const captureReadIdentity = () => { const captured = epoch; return () => captured === epoch; };
export function readResource<T>(key: string): T | null { return (resources.get(key) as T | undefined) ?? null; }
export function rememberResource<T>(key: string, data: T) {
  resources.delete(key); resources.set(key, data);
  if (resources.size > 40) resources.delete(resources.keys().next().value!);
}
export function forgetResource(key: string) { resources.delete(key); }
export function failedRead<T>(previous: ReadState<T>, error: unknown): ReadState<T> {
  const status = error instanceof SettingsRequestError ? error.status : null;
  const authority = status === 401 ? "signed-out" : status === 403 || status === 404 ? "revoked" : "unconfirmed";
  return { data: authority === "signed-out" || authority === "revoked" ? null : previous.data, request: "idle", authority, error };
}
