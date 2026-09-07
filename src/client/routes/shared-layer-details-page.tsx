import { BackButton } from "../navigation/back-button";
import { SharedLayerDetailsForm } from "../settings/shared-layer-details-form";
import { sharedLayerLabel } from "../../shared/annotations";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import {
  sharedLayerSlotSchema,
  sharedLayerManagementResponseSchema,
  type SharedLayerManagementSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse } from "../settings/settings-request";

export default function SharedLayerDetailsPage() {
  const { choirId = "", slot: slotParam = "" } = useParams();
  const session = authClient.useSession();
  return <SharedLayerDetails key={`${session.data?.user.id ?? "guest"}:${choirId}:${slotParam}`} choirId={choirId} slotParam={slotParam} />;
}

function SharedLayerDetails({ choirId, slotParam }: { choirId: string; slotParam: string }) {
  const parsedSlot = sharedLayerSlotSchema.safeParse(slotParam);
  const slot = parsedSlot.success ? parsedSlot.data : null;
  const [driveName, setDriveName] = useState("");
  const [layer, setLayer] = useState<SharedLayerManagementSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryLoad = () => {
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };
  useEffect(() => {
    if (!slot) return;
    let active = true;
    void 
      diagnosticFetch(`/api/choirs/${choirId}/shared-layers`).then(async (response) => {
        return sharedLayerManagementResponseSchema.parse(await settingsResponse(response));
      }).then((management) => {
      if (!active) return;
      setDriveName(management.drive.name);
      setLayer(management.layers.find((entry) => entry.slot === slot) ?? null);
      setLoading(false);
    }).catch((error: unknown) => {
      if (active) { setLoadError(settingsError(error, "暂时无法读取编辑权限。")); setLoading(false); }
    });
    return () => {
      active = false;
    };
  }, [choirId, slot, loadAttempt]);

  const layerName = layer ? sharedLayerLabel(layer.slot, layer.name) : slot ?? "共享层";


  return (
    <div className="app-page">
      <AppHeader actions={(
        <BackButton className="header-action" to={`/choirs/${choirId}/shared-layers`}>
          返回共享层管理
        </BackButton>
      )} />
      <main className="page-shell settings-page settings-ux">
        <header className="settings-heading">
          <p className="eyebrow">云盘管理 · {driveName || "共享层"}</p>
          <h1>{layerName}</h1>
          <p className="settings-copy">配置对当前云盘中的全部乐谱生效，不授予编辑内容的权限。停用的共享层暂停所有人的编辑，恢复后授权继续生效。</p>
        </header>
        {slot ? <SettingsFeedback loading={loading} loadError={loadError} message={null} retry={retryLoad} /> : <p role="alert">共享层不存在。</p>}
        {!loading && !loadError && layer && <SharedLayerDetailsForm choirId={choirId} layer={layer} onSaved={setLayer} />}
      </main>
    </div>
  );
}
