import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  sharedLayerManagementResponseSchema,
  type SharedLayerManagementSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";

export default function SharedLayerManagementPage() {
  const { choirId = "" } = useParams();
  const [driveName, setDriveName] = useState("");
  const [layers, setLayers] = useState<SharedLayerManagementSummary[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const pendingSlotsRef = useRef(new Set<string>());
  const [pendingSlots, setPendingSlots] = useState(new Set<string>());

  useEffect(() => {
    let active = true;
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layers`)
      .then(async (response) => {
        if (!response.ok) throw new Error("shared_layers_unavailable");
        return sharedLayerManagementResponseSchema.parse(await response.json());
      })
      .then((body) => {
        if (!active) return;
        setDriveName(body.drive.name);
        setLayers(body.layers);
      })
      .catch(() => {
        if (active) setMessage("暂时无法读取共享层管理设置，请稍后重试。");
      });
    return () => {
      active = false;
    };
  }, [choirId]);

  const saveDefaultColor = async (layer: SharedLayerManagementSummary, defaultColor: string) => {
    if (pendingSlotsRef.current.has(layer.slot)) return;
    pendingSlotsRef.current.add(layer.slot);
    setPendingSlots(new Set(pendingSlotsRef.current));
    const previousLayer = layer;
    setMessage(null);
    setLayers((current) => current.map((entry) =>
      entry.slot === layer.slot ? { ...entry, defaultColor } : entry));
    try {
      const response = await diagnosticFetch(`/api/choirs/${choirId}/shared-layers/${layer.slot}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultColor }),
      });
      if (!response.ok) throw new Error("layer_setting_update_failed");
      setMessage("云盘默认颜色已保存。");
    } catch {
      setLayers((current) => current.map((entry) =>
        entry.slot === previousLayer.slot ? previousLayer : entry));
      setMessage("颜色保存失败，原设置已保留。");
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
          <p className="eyebrow">云盘管理</p>
          <h1>共享层管理</h1>
          {driveName ? <p>{driveName}</p> : null}
          <p className="settings-copy">设置五个固定共享层的云盘默认颜色，并进入层详情管理编辑授权。</p>
        </header>
        {message ? <p className="library-message" role="status">{message}</p> : null}
        <section className="settings-card" aria-label="共享层管理列表">
          {layers.map((layer) => (
            <article className="settings-layer-row settings-layer-row--management" key={layer.slot}>
              <Link className="settings-layer-link" to={`/choirs/${choirId}/shared-layers/${layer.slot}`}>
                <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
                <strong><span>{layer.slot}</span> · {layer.name}</strong>
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
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
