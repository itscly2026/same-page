import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  driveLayerPreferencesResponseSchema,
  type DriveLayerPreferenceSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse, sharedLayerDescriptions } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function DriveLayerPreferencesPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <DriveLayerPreferences key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}

function DriveLayerPreferences({ choirId }: { choirId: string }) {
  const [driveName, setDriveName] = useState("");
  const [layers, setLayers] = useState<DriveLayerPreferenceSummary[]>([]);
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
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layer-preferences`)
      .then(async (response) => {
        return driveLayerPreferencesResponseSchema.parse(await settingsResponse(response));
      })
      .then((body) => {
        if (!active) return;
        setDriveName(body.drive.name);
        setLayers(body.layers);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (active) { setLoadError(settingsError(error, "暂时无法读取图层偏好。")); setLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [choirId, loadAttempt]);

  const updatePreference = async (
    layer: DriveLayerPreferenceSummary,
    changes: { subscribed?: boolean; colorOverride?: string | null },
  ) => {
    if (pendingSlotsRef.current.has(layer.slot)) return;
    const requestGeneration = generation.current;
    pendingSlotsRef.current.add(layer.slot);
    setPendingSlots(new Set(pendingSlotsRef.current));
    const previousLayer = layer;
    setMessage(null);
    setLayers((current) => current.map((entry) => {
      if (entry.slot !== layer.slot) return entry;
      const colorOverride = changes.colorOverride === undefined
        ? entry.colorOverride
        : changes.colorOverride;
      return {
        ...entry,
        subscribed: changes.subscribed ?? entry.subscribed,
        colorOverride,
        displayColor: colorOverride ?? entry.adminDefaultColor,
        colorSource: colorOverride ? "drive" : "admin",
      };
    }));
    try {
      const response = await diagnosticFetch(
        `/api/choirs/${choirId}/shared-layers/${layer.slot}/preference`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(changes),
        },
      );
      await settingsResponse(response);
      if (requestGeneration !== generation.current) return;
      setMessage("偏好已保存。单独设置过的乐谱保留自己的显示选择。");
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      setLayers((current) => current.map((entry) =>
        entry.slot === previousLayer.slot ? previousLayer : entry));
      setMessage(settingsError(error, "偏好保存失败，原设置已保留。请重试。"));
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
          <p className="eyebrow">我的偏好</p>
          <h1>我的图层偏好</h1>
          {driveName ? <p>适用于：{driveName}</p> : null}
          <p className="settings-copy">
            选择打开乐谱时默认显示的共享批注。单独设置过的乐谱会保留自己的显示选择。
          </p>
        </header>
        <SettingsFeedback loading={loading} loadError={loadError} message={message} retry={retryLoad} />
        <section className="settings-card" aria-label="共享层默认偏好" aria-busy={loading}>
          {layers.map((layer) => (
            <article className="settings-layer-row" key={layer.slot}>
              <div className="settings-layer-identity">
                <span className="settings-layer-swatch" style={{ background: layer.displayColor }} />
                <strong><span>{layer.slot}</span> · {layer.name} <span className="settings-layer-description">{sharedLayerDescriptions[layer.slot]}</span></strong>
                <small>{layer.colorOverride ? "我的颜色" : "跟随云盘颜色"}</small>
              </div>
              <label className="settings-toggle">
                <span>默认显示</span>
                <input
                  aria-label={`${layer.slot} · ${layer.name} 默认显示`}
                  checked={layer.subscribed}
                  disabled={pendingSlots.has(layer.slot)}
                  type="checkbox"
                  onChange={(event) => void updatePreference(layer, { subscribed: event.target.checked })}
                />
              </label>
              <label className="settings-color-control">
                <span>我的颜色</span>
                <input
                  aria-label={`${layer.slot} · ${layer.name} 我的颜色`}
                  type="color"
                  value={layer.displayColor}
                  disabled={pendingSlots.has(layer.slot)}
                  onChange={(event) => void updatePreference(layer, { colorOverride: event.target.value })}
                />
              </label>
              <div className="settings-color-options">
                <button
                  className="text-button"
                  disabled={!layer.colorOverride || pendingSlots.has(layer.slot)}
                  type="button"
                  onClick={() => void updatePreference(layer, { colorOverride: null })}
                >
                  {layer.colorOverride ? "使用云盘颜色" : "已使用云盘颜色"}
                </button>
              </div>
            {pendingSlots.has(layer.slot) ? <span className="settings-saving" role="status">正在保存…</span> : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
