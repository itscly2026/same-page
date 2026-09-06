import {
  annotationLayerSummarySchema,
  annotationPayloadSchema,
} from "../../shared/annotations";
import {
  localDatabase,
  type OfflineAnnotationSnapshot,
} from "../platform/local-database";
import {
  assertLocalWorkspaceActive,
  type LocalWorkspace,
  withLocalWorkspaceTransaction,
} from "../platform/local-workspace";

export async function captureOfflineAnnotationSnapshot(
  workspace: LocalWorkspace,
): Promise<OfflineAnnotationSnapshot> {
  await assertLocalWorkspaceActive(workspace);
  return withLocalWorkspaceTransaction(
    workspace,
    "r",
    [
      localDatabase.annotationLayers,
      localDatabase.annotations,
      localDatabase.annotationSyncCursors,
    ],
    async () => {
      const layers = await localDatabase.annotationLayers
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .toArray();
      const layerIds = new Set(layers.map(layer => layer.id));
      const annotations = await localDatabase.annotations
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .filter(annotation => layerIds.has(annotation.layerId))
        .toArray();
      for (const layer of layers) annotationLayerSummarySchema.parse(layer);
      for (const annotation of annotations) {
        if (annotation.payload) annotationPayloadSchema.parse(annotation.payload);
      }
      return {
        layers,
        annotations,
        cursor:
          (await localDatabase.annotationSyncCursors.get(workspace.scopeKey))
            ?.cursor ?? 0,
        verifiedAt: Date.now(),
      };
    },
  );
}

export async function ensureOfflineAppShell() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("service_worker_unavailable");
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error("service_worker_not_registered");
  if (!registration.active) throw new Error("service_worker_not_active");
}
