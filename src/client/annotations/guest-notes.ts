import type { AnnotationLayerSummary } from "../../shared/annotations";
import { localDatabase } from "../platform/local-database";
import { withLocalWorkspaceTransaction, type LocalWorkspace } from "../platform/local-workspace";

// Stable only within the owner/drive/score workspace; never a server layer.
export const GUEST_NOTE_LAYER_ID = "a2500000-0000-4000-8000-000000000001";
export function isLocalExperience(workspace: Pick<LocalWorkspace, "ownerKey">) {
  return workspace.ownerKey.startsWith("guest:") || workspace.ownerKey.startsWith("experience:");
}
export function guestNoteLayer(): AnnotationLayerSummary {
  return {
    id: GUEST_NOTE_LAYER_ID, kind: "personal", sharedSlot: null,
    name: "本机体验笔记", sortOrder: 100, subscribed: true,
    subscriptionSource: "personal", displayColor: "#dc2626", colorSource: "personal",
    adminDefaultColor: null, driveSubscribed: null, driveColorOverride: null,
    scoreSubscriptionOverride: null, canEdit: true, canShare: false, sharing: false,
  };
}
export function clearGuestNotes(workspace: LocalWorkspace) {
  if (!isLocalExperience(workspace)) throw new Error("guest_workspace_required");
  return withLocalWorkspaceTransaction(workspace, "rw", [localDatabase.annotations, localDatabase.offlineSnapshots], async () => {
    await localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey)
      .filter(note => note.layerId === GUEST_NOTE_LAYER_ID).delete();
    await localDatabase.offlineSnapshots.where("scopeKey").equals(workspace.scopeKey).modify(record => {
      record.annotationSnapshot.annotations = record.annotationSnapshot.annotations.filter(note => note.layerId !== GUEST_NOTE_LAYER_ID);
    });
  });
}
