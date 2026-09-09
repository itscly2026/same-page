import { projectReadingPreferences } from "./reading-preferences";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { useEffect, useSyncExternalStore } from "react";
import { onReaderIdentityChange } from "./reader-cache-events";
import type { LocalWorkspace } from "../platform/local-workspace";
import type { ReadingPreferenceRecord } from "./reading-preferences";

export type ReadingPreferenceIntent = ReadingPreferenceRecord & { localState: "saving" | "failed" | "saved" };
let intents: ReadingPreferenceIntent[] = [];
const listeners = new Set<() => void>();
function publish() { for (const listener of listeners) listener(); }
export function clearReadingIntents() { intents = []; publish(); }
onReaderIdentityChange(clearReadingIntents);
export function setReadingIntent(intent: ReadingPreferenceIntent) {
  intents = [...intents.filter(row => row.key !== intent.key), intent]; publish();
}
export function finishReadingIntent(key: string, version: string, failed = false) {
  intents = intents.flatMap(row => row.key !== key || row.version !== version ? [row] : failed ? [{ ...row, localState: "failed" as const }] : [{ ...row, localState: "saved" as const }]); publish();
}
export function currentReadingIntent(key: string) { return intents.find(row => row.key === key); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => intents;
export function useReadingPreferenceIntents(workspace: LocalWorkspace | null) {
  return useSyncExternalStore(subscribe, snapshot).filter(row => workspace && row.ownerKey === workspace.ownerKey && row.choirId === workspace.choirId && (row.kind === "drive" || row.scoreId === workspace.scoreId));
}

export function clearReadingIntent(key: string, version: string) {
  intents = intents.filter(row => row.key !== key || row.version !== version); publish();
}
export function useReadingPreferenceProjection(workspace: LocalWorkspace | null, layers: AnnotationLayerSummary[]) {
  const pending = useReadingPreferenceIntents(workspace);
  useEffect(() => {
    for (const intent of pending.filter(row => row.localState === "saved" && row.kind !== "drive")) {
      const layer = layers.find(layer => intent.kind === "shared" ? layer.sharedSlot === intent.id : layer.id === intent.id);
      if (!layer) continue;
      const projected = projectReadingPreferences(layer, [intent]);
      if (layer.subscribed === projected.subscribed && layer.displayColor === projected.displayColor && layer.scoreSubscriptionOverride === projected.scoreSubscriptionOverride && (layer.scoreColorOverride ?? null) === (projected.scoreColorOverride ?? null)) clearReadingIntent(intent.key, intent.version);
    }
  }, [layers, pending]);
  return layers.map(layer => projectReadingPreferences(layer, pending));
}
