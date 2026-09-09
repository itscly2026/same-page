import { useReadingPreferenceIntents, currentReadingIntent, setReadingIntent, finishReadingIntent } from "./reading-preference-intents";
import { useEffect, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { captureLocalWorkspaceSession, type LocalWorkspace } from "../platform/local-workspace";
import { flushReadingPreferences, preferenceKey, readReadingPreferences, saveReadingPreference, type PreferenceTarget, type ReadingPreferenceChange } from "./reading-preferences";

export function useReadingPreferences(workspace: LocalWorkspace, signedIn: boolean) {
  const lifetime = useRef<AbortController | null>(null);
  const savedRows = useLiveQuery(() => readReadingPreferences(workspace), [workspace.scopeKey], []);
  const intents = useReadingPreferenceIntents(workspace);
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
    const previous = currentReadingIntent(key) ?? savedRows.find(row => row.key === key);
    const intent = { ...previous, ...target, ...change, key, version: crypto.randomUUID(), ownerKey: workspace.ownerKey,
      choirId: workspace.choirId, scoreId: target.kind === "drive" ? "" : workspace.scoreId, pending: true, observed: false, error: null, localState: "saving" as const };
    setReadingIntent(intent);
    try {
      const current = await captureLocalWorkspaceSession(workspace);
      if (currentReadingIntent(key)?.version !== intent.version) return;
      await saveReadingPreference(current, target, { subscribed: intent.subscribed, colorOverride: intent.colorOverride });
      finishReadingIntent(key, intent.version);
      if (signedIn && !signal?.aborted) void flushReadingPreferences(current, undefined, signal).catch(() => undefined);
    } catch { finishReadingIntent(key, intent.version, true); }
  };
  const feedback = (target: PreferenceTarget) => {
    const key = preferenceKey(workspace, target);
    const intent = intents.find(row => row.key === key);
    const row = rows.find(row => row.key === key);
    return intent ? { message: intent.localState === "failed" ? "尚未保存到本机，请重试。" : "正在保存到本机…", retry: intent.localState === "failed" ? () => void save(target, { subscribed: intent.subscribed, colorOverride: intent.colorOverride }) : undefined }
      : row ? { message: row.error ?? (row.pending ? "已保存到本机，等待同步。" : signedIn ? "已同步。" : "已保存到本机。"),
        retry: row.error ? () => { if (signedIn) void captureLocalWorkspaceSession(workspace).then(current => flushReadingPreferences(current, undefined, lifetime.current?.signal)).catch(() => undefined); } : undefined } : null;
  };
  return { save, feedback, rows };
}
