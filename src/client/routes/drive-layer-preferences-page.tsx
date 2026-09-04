import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  driveLayerPreferencesResponseSchema,
  type DriveLayerPreferenceSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";

export default function DriveLayerPreferencesPage() {
  const { choirId = "" } = useParams();
  const [driveName, setDriveName] = useState("");
  const [layers, setLayers] = useState<DriveLayerPreferenceSummary[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const pendingSlotsRef = useRef(new Set<string>());
  const [pendingSlots, setPendingSlots] = useState(new Set<string>());

  useEffect(() => {
    let active = true;
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layer-preferences`)
      .then(async (response) => {
        if (!response.ok) throw new Error("preferences_unavailable");
        return driveLayerPreferencesResponseSchema.parse(await response.json());
      })
      .then((body) => {
        if (!active) return;
        setDriveName(body.drive.name);
        setLayers(body.layers);
      })
      .catch(() => {
        if (active) setMessage("暂时无法读取图层偏好，请稍后重试。");
      });
    return () => {
      active = false;
    };
  }, [choirId]);

  const updatePreference = async (
    layer: DriveLayerPreferenceSummary,
    changes: { subscribed?: boolean; colorOverride?: string | null },
  ) => {
    if (pendingSlotsRef.current.has(layer.slot)) return;
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
      if (!response.ok) throw new Error("preference_update_failed");
      setMessage("偏好已保存。已有本谱覆盖的乐谱不会改变。");
    } catch {
      setLayers((current) => current.map((entry) =>
        entry.slot === previousLayer.slot ? previousLayer : entry));
      setMessage("偏好保存失败，原设置已保留。");
    } finally {
      pendingSlotsRef.current.delete(layer.slot);
      setPendingSlots(new Set(pendingSlotsRef.current));
    }
  };

  return (
    <div className="app-page">
      <AppHeader actions={<Link className="header-action" to={`/choirs/${choirId}`}>返回云盘</Link>} />
      <main className="page-shell settings-page">
        <header className="settings-heading">
          <p className="eyebrow">我的偏好</p>
          <h1>我的图层偏好</h1>
          {driveName ? <p>适用于：{driveName}</p> : null}
          <p className="settings-copy">
            这些设置是当前云盘中未单独设置乐谱的默认值；已有本谱覆盖不会被静默改写。
          </p>
        </header>
        {message ? <p className="library-message" role="status">{message}</p> : null}
        <section className="settings-card" aria-label="共享层默认偏好">
          {layers.map((layer) => (
            <article className="settings-layer-row" key={layer.slot}>
              <div className="settings-layer-identity">
                <span className="settings-layer-swatch" style={{ background: layer.displayColor }} />
                <strong><span>{layer.slot}</span> · {layer.name}</strong>
                <small>{layer.colorOverride ? "我的颜色" : "跟随云盘颜色"}</small>
              </div>
              <label className="settings-toggle">
                <span>默认订阅</span>
                <input
                  aria-label={`${layer.slot} · ${layer.name} 默认订阅`}
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
              {layer.colorOverride ? (
                <button
                  className="text-button"
                  disabled={pendingSlots.has(layer.slot)}
                  type="button"
                  onClick={() => void updatePreference(layer, { colorOverride: null })}
                >
                  使用云盘颜色
                </button>
              ) : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
