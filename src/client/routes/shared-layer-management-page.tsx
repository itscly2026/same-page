import { sharedLayerLabel, sharedLayerPrefix } from "../../shared/annotations";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  sharedLayerManagementResponseSchema,
  type SharedLayerManagementSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function SharedLayerManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <SharedLayerManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}

function SharedLayerManagement({ choirId }: { choirId: string }) {
  const [newName, setNewName] = useState("");
  const [createMessage, setCreateMessage] = useState("");
  const [creating, setCreating] = useState(false);
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
  const [results, setResults] = useState<Record<string, { message: string; failedColor?: string }>>({});
  const pendingSlotsRef = useRef(new Set<string>());
  const [pendingSlots, setPendingSlots] = useState(new Set<string>());

  useEffect(() => {
    let active = true;
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layers`)
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
    setResults((current) => ({ ...current, [layer.slot]: { message: "正在保存…" } }));
    try {
      const response = await diagnosticFetch(`/api/choirs/${choirId}/shared-layers/${layer.slot}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultColor }),
      });
      await settingsResponse(response);
      if (requestGeneration !== generation.current) return;
      setLayers((current) => current.map((entry) =>
        entry.slot === layer.slot ? { ...entry, defaultColor } : entry));
      setResults((current) => ({ ...current, [layer.slot]: { message: "云盘默认颜色已保存。" } }));
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      setResults((current) => ({ ...current, [layer.slot]: {
        message: settingsError(error, "颜色保存失败，原设置已保留。"), failedColor: defaultColor,
      } }));
    } finally {
      if (requestGeneration === generation.current) {
        pendingSlotsRef.current.delete(layer.slot);
        setPendingSlots(new Set(pendingSlotsRef.current));
      }
    }
  };

  const updateDefinition = async (layer: SharedLayerManagementSummary, changes: { name?: string; sortOrder?: number; active?: boolean }) => {
    if (pendingSlotsRef.current.has(layer.slot)) return;
    const requestGeneration = generation.current;
    pendingSlotsRef.current.add(layer.slot); setPendingSlots(new Set(pendingSlotsRef.current));
    try {
      await settingsResponse(await diagnosticFetch(`/api/choirs/${choirId}/shared-layers/${layer.slot}/settings`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changes),
      }));
      if (requestGeneration !== generation.current) return;
      setLayers(current => current.map(entry => entry.slot === layer.slot ? { ...entry, ...changes } : entry)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.slot.localeCompare(b.slot)));
      setResults(current => ({ ...current, [layer.slot]: { message: "共享层设置已保存。" } }));
    } catch (error) {
      if (requestGeneration === generation.current) setResults(current => ({ ...current, [layer.slot]: {
        message: settingsError(error, "保存失败，原设置已保留，请重试。"),
      } }));
    } finally {
      if (requestGeneration === generation.current) {
        pendingSlotsRef.current.delete(layer.slot); setPendingSlots(new Set(pendingSlotsRef.current));
      }
    }
  };
  const createLayer = async () => {
    if (creating || !newName.trim()) return;
    setCreating(true); setCreateMessage("正在创建…");
    const requestGeneration = generation.current;
    try {
      await settingsResponse(await diagnosticFetch(`/api/choirs/${choirId}/shared-layers`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newName.trim(), defaultColor: "#3157a4" }),
      }));
      if (requestGeneration !== generation.current) return;
      setNewName(""); setCreateMessage("共享层已创建。"); retryLoad();
    } catch (error) {
      if (requestGeneration === generation.current) setCreateMessage(settingsError(error, "创建失败，请重试。"));
    } finally { if (requestGeneration === generation.current) setCreating(false); }
  };

  return (
    <div className="app-page">
      <AppHeader actions={<Link className="header-action" to={`/choirs/${choirId}`}>返回云盘</Link>} />
      <main className="page-shell settings-page settings-ux">
        <header className="settings-heading">
          <p className="eyebrow">云盘管理</p>
          <h1>共享层管理</h1>
          {driveName ? <p>{driveName}</p> : null}
          <p className="settings-copy">共享层配置对云盘内所有乐谱生效。可调整名称、顺序、默认颜色和编辑权限。停用会隐藏该层并暂停编辑，笔记保留，恢复后可继续使用。</p>
        </header>
        <SettingsFeedback loading={loading} loadError={loadError} message={null} retry={retryLoad} />
        <form className="settings-card layer-definition-form" onSubmit={event => { event.preventDefault(); void createLayer(); }}>
          <label>新共享层名称<input value={newName} maxLength={60} required disabled={creating} onChange={event => setNewName(event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={creating || loading}>新增共享层</button>
          {createMessage ? <p role="status">{createMessage}</p> : null}
        </form>
        <section className="settings-card" aria-label="共享层管理列表" aria-busy={loading}>
          {layers.map((layer) => (
            <article className="settings-layer-row settings-layer-row--management" key={layer.slot}>
              <Link className="settings-layer-link" to={`/choirs/${choirId}/shared-layers/${layer.slot}`}>
                <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
                <strong><span>{sharedLayerPrefix(layer.slot) ? `${layer.slot} · ` : ""}</span> {layer.name}</strong>
                <small>已授权 {layer.grantedMemberCount} 位成员</small>
                <span aria-hidden="true">›</span>
              </Link>
              <LayerDefinitionForm key={`${layer.slot}:${layer.name}:${layer.sortOrder}:${layer.active}`} layer={layer}
                pending={pendingSlots.has(layer.slot)} save={changes => void updateDefinition(layer, changes)} />
              <label className="settings-color-control">
                <span>云盘默认颜色</span>
                <input
                  aria-label={`${sharedLayerLabel(layer.slot, layer.name)} 云盘默认颜色`}
                  type="color"
                  value={layer.defaultColor}
                  disabled={pendingSlots.has(layer.slot)}
                  onChange={(event) => void saveDefaultColor(layer, event.target.value)}
                />
              </label>
            {results[layer.slot] ? <div className="settings-row-feedback">
              <span role={results[layer.slot].failedColor ? "alert" : "status"}>{results[layer.slot].message}</span>
              {results[layer.slot].failedColor ? <button type="button" className="text-button"
                disabled={pendingSlots.has(layer.slot)} aria-label={`重试 ${sharedLayerLabel(layer.slot, layer.name)}`}
                onClick={() => void saveDefaultColor(layer, results[layer.slot].failedColor!)}>重试</button> : null}
            </div> : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}

function LayerDefinitionForm({ layer, pending, save }: { layer: SharedLayerManagementSummary; pending: boolean;
  save: (changes: { name?: string; sortOrder?: number; active?: boolean }) => void }) {
  const [name, setName] = useState(layer.name);
  const [order, setOrder] = useState(layer.sortOrder);
  return <form className="layer-definition-form" onSubmit={event => { event.preventDefault(); save({ name: name.trim(), sortOrder: order }); }}>
    <label>名称<input aria-label={`${layer.name} 名称`} value={name} required maxLength={60} disabled={pending} onChange={event => setName(event.target.value)} /></label>
    <label>顺序<input aria-label={`${layer.name} 顺序`} type="number" min={0} max={10000} value={order} required disabled={pending} onChange={event => setOrder(Number(event.target.value))} /></label>
    <button className="secondary-button" type="submit" disabled={pending}>保存名称和顺序</button>
    <button className="text-button" type="button" disabled={pending} onClick={() => save({ active: !layer.active })}>{layer.active ? "停用" : "恢复"} {layer.name}</button>
  </form>;
}
