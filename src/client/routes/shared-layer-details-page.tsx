import { SharedLayerDetailsForm } from "../settings/shared-layer-details-form";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useReadResource } from "../settings/use-read-resource";
import { useParams } from "react-router-dom";

import {
  sharedLayerSlotSchema,
  sharedLayerManagementResponseSchema,
  type SharedLayerManagementSummary,
} from "../../shared/annotations";
import { TaskHeader } from "../components/task-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse } from "../settings/settings-request";

export default function SharedLayerDetailsPage() {
  const { choirId = "", slot: slotParam = "" } = useParams();
  const session = authClient.useSession();
  return <SharedLayerDetails key={`${session.data?.user.id ?? "guest"}:${choirId}:${slotParam}`} choirId={choirId} slotParam={slotParam} userId={session.data?.user.id ?? null} />;
}

function SharedLayerDetails({ choirId, slotParam, userId }: { choirId: string; slotParam: string; userId: string | null }) {
  const parsedSlot = sharedLayerSlotSchema.safeParse(slotParam);
  const slot = parsedSlot.success ? parsedSlot.data : null;
  const resource = useReadResource(`${userId}:${choirId}:shared-layer:${slotParam}`, async signal => {
    if (!slot) throw new Error("invalid_shared_layer");
    return sharedLayerManagementResponseSchema.parse(await settingsResponse(await diagnosticFetch(`/api/choirs/${choirId}/shared-layers`, { signal })));
  });
  const driveName = resource.data?.drive.name ?? "";
  const layer = resource.data?.layers.find(entry => entry.slot === slot) ?? null;
  const loadError = resource.error ? settingsError(resource.error, "暂时无法读取编辑权限。") : null;
  const setLayer = (next: SharedLayerManagementSummary) => {
    if (resource.data) resource.confirm({ ...resource.data, layers: resource.data.layers.map(entry => entry.slot === next.slot ? next : entry) });
  };

  const layerName = layer ? layer.name : slot ?? "共享层";


  return (
    <div className="app-page">
      <TaskHeader title={layerName} backTo={`/choirs/${choirId}/shared-layers`} />
      <main className="page-shell settings-page settings-ux">
        <header className="settings-heading">
          <p className="eyebrow">云盘设置 · {driveName || "共享层"}</p>

          <p className="settings-copy">配置对当前云盘中的全部乐谱生效，不授予编辑内容的权限。停用的共享层暂停所有人的编辑，恢复后授权继续生效。</p>
        </header>
        {slot ? <SettingsFeedback loading={resource.loading} loadError={loadError} message={null} retry={() => void resource.refresh().catch(() => undefined)} /> : <p role="alert">共享层不存在。</p>}
        {layer && <SharedLayerDetailsForm choirId={choirId} layer={layer} onSaved={setLayer} authorized={resource.canMutate} refresh={resource.refresh} onRevoked={resource.clear} />}
      </main>
    </div>
  );
}
