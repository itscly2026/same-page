import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  sharedLayerManagementResponseSchema,
  type SharedLayerManagementSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse, sharedLayerDescriptions } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function SharedLayerManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <SharedLayerManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}

function SharedLayerManagement({ choirId }: { choirId: string }) {
  const [driveName, setDriveName] = useState("");
  const [layers, setLayers] = useState<SharedLayerManagementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generation = useSettingsLifetime();
  const retryLoad = () => {
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };
  const [message, setMessage] = useState<string | null>(null);
  const pendingSlotsRef = useRef(new Set<string>());
  const [pendingSlots, setPendingSlots] = useState(new Set<string>());

  useEffect(() => {
    let active = true;
    void fetch(`/api/choirs/${choirId}/shared-layers`)
      .then(async (response) => {
        return sharedLayerManagementResponseSchema.parse(await settingsResponse(response));
      })
      .then((body) => {
        if (!active) return;
        setDriveName(body.drive.name);
        setLayers(body.layers);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (active) { setLoadError(settingsError(error, "暂时无法读取共享层管理设置。")); setLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [choirId, loadAttempt]);

  const saveDefaultColor = async (layer: SharedLayerManagementSummary, defaultColor: string) => {
    if (pendingSlotsRef.current.has(layer.slot)) return;
    const requestGeneration = generation.current;
    pendingSlotsRef.current.add(layer.slot);
    setPendingSlots(new Set(pendingSlotsRef.current));
    const previousLayer = layer;
    setMessage(null);
    setLayers((current) => current.map((entry) =>
      entry.slot === layer.slot ? { ...entry, defaultColor } : entry));
    try {
      const response = await fetch(`/api/choirs/${choirId}/shared-layers/${layer.slot}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultColor }),
      });
      await settingsResponse(response);
      if (requestGeneration !== generation.current) return;
      setMessage("云盘默认颜色已保存。");
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      setLayers((current) => current.map((entry) =>
        entry.slot === previousLayer.slot ? previousLayer : entry));
      setMessage(settingsError(error, "颜色保存失败，原设置已保留。请重试。"));
    } finally {
      if (requestGeneration === generation.current) {
        pendingSlotsRef.current.delete(layer.slot);
        setPendingSlots(new Set(pendingSlotsRef.current));
      }
    }
  };

  return (
    <div className="app-page">
      <AppHeader actions={<Link className="header-action" to={`/choirs/${choirId}`}>返回云盘</Link>} />
      <main className="page-shell settings-page settings-ux">
        <header className="settings-heading">
          <p className="eyebrow">云盘管理</p>
          <h1>共享层管理</h1>
          {driveName ? <p>{driveName}</p> : null}
          <p className="settings-copy">设置共享批注的默认颜色，或选择一个层管理谁可以编辑。颜色不会改变编辑权限，成员也可以选择自己的显示颜色。</p>
        </header>
        <SettingsFeedback loading={loading} loadError={loadError} message={message} retry={retryLoad} />
        <section className="settings-card" aria-label="共享层管理列表" aria-busy={loading}>
          {layers.map((layer) => (
            <article className="settings-layer-row settings-layer-row--management" key={layer.slot}>
              <Link className="settings-layer-link" to={`/choirs/${choirId}/shared-layers/${layer.slot}`}>
                <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
                <strong><span>{layer.slot}</span> · {layer.name} <span className="settings-layer-description">{sharedLayerDescriptions[layer.slot]}</span></strong>
                <small>已授权 {layer.grantedMemberCount} 位成员</small>
                <span aria-hidden="true">›</span>
              </Link>
              <label className="settings-color-control">
                <span>云盘默认颜色</span>
                <input
                  aria-label={`${layer.slot} · ${layer.name} 云盘默认颜色`}
                  type="color"
                  value={layer.defaultColor}
                  disabled={pendingSlots.has(layer.slot)}
                  onChange={(event) => void saveDefaultColor(layer, event.target.value)}
                />
              </label>
            {pendingSlots.has(layer.slot) ? <span className="settings-saving" role="status">正在保存…</span> : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
