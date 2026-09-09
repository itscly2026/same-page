import { resolveSharedLayerPreference, type AnnotationLayerSummary } from "../../shared/annotations";
import { localDatabase } from "../platform/local-database";
import { assertLocalWorkspaceActive, withLocalWorkspaceTransaction, type LocalWorkspace } from "../platform/local-workspace";
import { diagnosticFetch } from "../diagnostics/diagnostics";

export type PreferenceTarget = { kind: "shared" | "personal" | "drive"; id: string };
export type ReadingPreferenceChange = { subscribed?: boolean | null; colorOverride?: string | null };
export type ReadingPreferenceRecord = PreferenceTarget & ReadingPreferenceChange & {
  key: string; ownerKey: LocalWorkspace["ownerKey"]; choirId: string; scoreId: string;
  version: string; observed?: boolean; pending: boolean; error: string | null;
};
export const preferenceKey = (workspace: LocalWorkspace, target: PreferenceTarget) => JSON.stringify([workspace.ownerKey, workspace.choirId, target.kind === "drive" ? "" : workspace.scoreId, target.kind, target.id]);
export function readReadingPreferences(workspace: LocalWorkspace) {
  return localDatabase.readingPreferences.where("ownerKey").equals(workspace.ownerKey)
    .filter(row => row.choirId === workspace.choirId && (row.kind === "drive" || row.scoreId === workspace.scoreId)).toArray();
}

// Preferences never add a layer or grant authority: only project display fields
// onto the current authorized layer list. Pending intent survives every pull.
export function projectReadingPreferences(layer: AnnotationLayerSummary, rows: ReadingPreferenceRecord[]): AnnotationLayerSummary {
  if (layer.kind === "personal") {
    const row = rows.find(row => row.kind === "personal" && row.id === layer.id);
    return row && typeof row.subscribed === "boolean" ? { ...layer, subscribed: row.subscribed } : layer;
  }
  const drive = rows.find(row => row.kind === "drive" && row.id === layer.sharedSlot);
  const score = rows.find(row => row.kind === "shared" && row.id === layer.sharedSlot);
  if (!drive && !score) return layer;
  const fields = { driveSubscribed: drive?.subscribed ?? layer.driveSubscribed,
    driveColorOverride: drive?.colorOverride === undefined ? layer.driveColorOverride : drive.colorOverride,
    scoreSubscriptionOverride: score?.subscribed === undefined ? layer.scoreSubscriptionOverride : score.subscribed,
    scoreColorOverride: score?.colorOverride === undefined ? layer.scoreColorOverride ?? null : score.colorOverride };
  return { ...layer, ...fields, ...resolveSharedLayerPreference({ ...fields, productDefaultColor: "#dc2626", adminDefaultColor: layer.adminDefaultColor }) };
}

export async function saveReadingPreference(workspace: LocalWorkspace, target: PreferenceTarget, change: ReadingPreferenceChange) {
  return withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.readingPreferences, localDatabase.annotationLayers], async () => {
    const key = preferenceKey(workspace, target);
    const previous = await localDatabase.readingPreferences.get(key);
    const row: ReadingPreferenceRecord = { ...previous, ...target, ...change, key, ownerKey: workspace.ownerKey,
      choirId: workspace.choirId, scoreId: target.kind === "drive" ? "" : workspace.scoreId,
      version: crypto.randomUUID(), observed: false, pending: workspace.ownerKey.startsWith("user:"), error: null };
    await localDatabase.readingPreferences.put(row);
    await localDatabase.system.put({ key: readingPreferenceVersionKey(workspace), value: crypto.randomUUID() });
    const layers = await localDatabase.annotationLayers.where("ownerKey").equals(workspace.ownerKey)
      .filter(layer => layer.choirId === workspace.choirId && (target.kind === "drive" || layer.scoreId === workspace.scoreId)).toArray();
    for (const layer of layers) await localDatabase.annotationLayers.put(projectReadingPreferences(layer, [row]) as typeof layer);
    return row;
  });
}

const running = new Map<string, Promise<void>>();
// Each key is serialized independently; IDB holds the latest merged intent,
// including edits made while an older request is in flight.
export async function flushReadingPreferences(workspace: LocalWorkspace, transport: typeof fetch = diagnosticFetch, signal?: AbortSignal) {
  await assertLocalWorkspaceActive(workspace);
  if (!workspace.ownerKey.startsWith("user:")) return;
  signal?.throwIfAborted();
  if (!navigator.onLine) return;
  const rows = await readReadingPreferences(workspace);
  await Promise.all(rows.filter(row => row.pending).map(row => {
    const existing = running.get(row.key);
    if (existing) return existing;
    const task = flushKey(workspace, row.key, transport, signal).finally(() => { if (running.get(row.key) === task) running.delete(row.key); });
    running.set(row.key, task);
    return task;
  }));
}
export const readingPreferenceVersionKey = (workspace: LocalWorkspace) => JSON.stringify(["reading-preference-version", workspace.ownerKey, workspace.choirId]);
export async function readingPreferenceVersion(workspace: LocalWorkspace) { return (await localDatabase.system.get(readingPreferenceVersionKey(workspace)))?.value ?? ""; }

async function flushKey(workspace: LocalWorkspace, key: string, transport: typeof fetch, signal?: AbortSignal) {
  while (true) {
    await assertLocalWorkspaceActive(workspace);
    signal?.throwIfAborted();
    const directory = await localDatabase.driveDirectories.get(JSON.stringify([workspace.ownerKey, workspace.choirId]));
    if (directory?.accessRevoked) return;
    const row = await localDatabase.readingPreferences.get(key);
    if (!row?.pending) return;
    const base = `/api/choirs/${encodeURIComponent(row.choirId)}`;
    const path = row.kind === "drive" ? `${base}/shared-layers/${encodeURIComponent(row.id)}/preference`
      : `${base}/scores/${encodeURIComponent(row.scoreId)}/${row.kind === "shared" ? "shared-layers" : "personal-layers"}/${encodeURIComponent(row.id)}/${row.kind === "shared" ? "preference" : "subscription"}`;
    let error: string | null = null;
    try {
      const response = await transport(path, { method: "PUT", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
        headers: { "content-type": "application/json", "x-same-page-owner-user-id": workspace.ownerKey.slice(5) },
        body: JSON.stringify({ subscribed: row.subscribed, colorOverride: row.colorOverride }) });
      if (!response.ok) error = response.status === 401 ? "登录已失效，重新登录后重试。"
        : response.status === 403 || response.status === 404 ? "当前无法访问此偏好，请刷新并确认访问权限。" : "云端保存失败，本机选择已保留。";
    } catch { error = "暂时无法连接，本机选择已保留，联网后重试。"; }
    signal?.throwIfAborted();
    await withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.readingPreferences], async () => {
      const latest = await localDatabase.readingPreferences.get(key);
      if (latest?.version === row.version) {
        await localDatabase.readingPreferences.update(key, { pending: !!error, error });
        await localDatabase.system.put({ key: readingPreferenceVersionKey(workspace), value: crypto.randomUUID() });
      }
    });
    if (error) return;
  }
}
