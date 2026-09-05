import type { ScoreDisplayMode } from "../../shared/score-images";
import type { LocalWorkspace } from "../platform/local-workspace";

function key(workspace: LocalWorkspace, score: boolean) {
  return JSON.stringify(["score-display", workspace.ownerKey, ...(score ? [workspace.choirId, workspace.scoreId] : [])]);
}
export function readDisplayPreference(workspace: LocalWorkspace): ScoreDisplayMode {
  try {
    const chosen = localStorage.getItem(key(workspace, true)) ?? localStorage.getItem(key(workspace, false));
    return chosen === "images" ? "images" : "pdf";
  } catch { return "pdf"; }
}
export function writeDisplayPreference(workspace: LocalWorkspace, mode: ScoreDisplayMode | null, scope: "score" | "default") {
  try {
    const storageKey = key(workspace, scope === "score");
    if (mode === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, mode);
  } catch { /* The current choice can still work when preferences cannot persist. */ }
}
