import type { AnnotationLayerSummary, DriveLayerPreferenceSummary } from "../../shared/annotations";
import { useReadResource } from "../settings/use-read-resource";
import { useReadingPreferenceIntents, currentReadingIntent, setReadingIntent, finishReadingIntent, clearReadingIntent } from "./reading-preference-intents";
import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { captureLocalWorkspaceSession, type LocalWorkspace } from "../platform/local-workspace";
import { loadDriveReadingPreferences, restoreDriveReadingPreferences, projectDriveReadingPreferences, projectReadingPreferences, flushReadingPreferences, preferenceKey, readReadingPreferences, saveReadingPreference, type PreferenceTarget, type ReadingPreferenceChange } from "./reading-preferences";

export function useReadingPreferences(workspace: LocalWorkspace, signedIn: boolean) {
  const lifetime = useRef<AbortController | null>(null);
  const savedRows = useLiveQuery(() => readReadingPreferences(workspace), [workspace.scopeKey], []);
  const intents = useReadingPreferenceIntents(workspace);
  useEffect(() => {
    for (const intent of intents.filter(row => row.kind === "drive" && row.localState === "saved")) {
      if (savedRows.some(row => row.key === intent.key && row.version === intent.version)) clearReadingIntent(intent.key, intent.version);
    }
  }, [intents, savedRows]);
  const rows = [...savedRows.filter(row => !intents.some(intent => intent.key === row.key)), ...intents];
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    if (!signedIn) return () => controller.abort();
    let active = true;
    const retry = () => { void captureLocalWorkspaceSession(workspace).then(current => {
      if (active) return flushReadingPreferences(current, undefined, controller.signal);
    }).catch(() => undefined); };
    retry(); window.addEventListener("online", retry);
    return () => { active = false; controller.abort(); window.removeEventListener("online", retry); };
  }, [workspace, signedIn]);
  const save = async (target: PreferenceTarget, change: ReadingPreferenceChange) => {
    const key = preferenceKey(workspace, target);
    const signal = lifetime.current?.signal;
    const previous = currentReadingIntent(key) ?? savedRows.find(row => row.key === key && !row.observed);
    const intent = { ...previous, ...target, ...change, key, version: crypto.randomUUID(), ownerKey: workspace.ownerKey,
      choirId: workspace.choirId, scoreId: target.kind === "drive" ? "" : workspace.scoreId, pending: true, observed: false, error: null, localState: "saving" as const };
    setReadingIntent(intent);
    try {
      const current = await captureLocalWorkspaceSession(workspace);
      if (currentReadingIntent(key)?.version !== intent.version) return;
      await saveReadingPreference(current, target, { subscribed: intent.subscribed, colorOverride: intent.colorOverride }, intent.version);
      finishReadingIntent(key, intent.version);
      if (signedIn && !signal?.aborted) void flushReadingPreferences(current, undefined, signal, key).catch(() => undefined);
    } catch { finishReadingIntent(key, intent.version, true); }
  };
  const feedback = (target: PreferenceTarget) => {
    const key = preferenceKey(workspace, target);
    const intent = intents.find(row => row.key === key);
    const row = savedRows.find(row => row.key === key);
    if (intent && intent.localState !== "saved") return intent.localState === "failed"
      ? { message: "尚未保存到本机，请重试。", retry: () => void save(target, { subscribed: intent.subscribed, colorOverride: intent.colorOverride }) }
      : null;
    return row?.error ? { message: row.error, retry: () => {
      if (signedIn) void captureLocalWorkspaceSession(workspace).then(current => flushReadingPreferences(current, undefined, lifetime.current?.signal, key)).catch(() => undefined);
    } } : null;
  };
  return { save, feedback,
    projectDriveLayers: (layers: DriveLayerPreferenceSummary[]) => projectDriveReadingPreferences(layers, rows),
    projectLayers: (layers: AnnotationLayerSummary[]) =>
      layers.map(layer => projectReadingPreferences(layer, rows.filter(row => !row.observed))),
  };
}

// The page consumes display state and save intent; cache and reconciliation
// knowledge stays with the reading preference implementation.
export function useDriveReadingPreferences(workspace: LocalWorkspace, signedIn: boolean) {
  const resource = useReadResource(`${workspace.ownerKey}:${workspace.choirId}:reading-defaults`,
    signal => loadDriveReadingPreferences(workspace, signal),
    () => restoreDriveReadingPreferences(workspace));
  const preferences = useReadingPreferences(workspace, signedIn && resource.authority !== "revoked" && resource.authority !== "signed-out");
  return { drive: resource.data?.drive ?? null, layers: preferences.projectDriveLayers(resource.data?.layers ?? []),
    loading: resource.loading, error: resource.error, authority: resource.authority, refresh: resource.refresh,
    save: preferences.save, feedback: preferences.feedback };
}
