import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { sharedLayerLabel, sharedLayerManagementResponseSchema, type SharedLayerManagementSummary } from "../../shared/annotations";
import { diagnosticFetch } from "../diagnostics/diagnostics";
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
  const [driveName, setDriveName] = useState("");
  const [layers, setLayers] = useState<SharedLayerManagementSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [feedback, setFeedback] = useState<{ message: string; failed?: boolean } | null>(null);
  const generation = useSettingsLifetime();
  const retryLoad = () => { setLoading(true); setLoadError(null); setLoadAttempt(value => value + 1); };

  useEffect(() => {
    const controller = new AbortController();
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layers`, { signal: controller.signal })
      .then(settingsResponse).then(value => {
        const body = sharedLayerManagementResponseSchema.parse(value);
        if (controller.signal.aborted) return;
        setDriveName(body.drive.name); setLayers(body.layers); setLoading(false);
      }).catch(error => {
        if (!controller.signal.aborted) { setLoadError(settingsError(error, "暂时无法读取共享层管理设置。")); setLoading(false); }
      });
    return () => controller.abort();
  }, [choirId, loadAttempt]);

  const change = async (path: string, method: "POST" | "PUT", body: object, message: string) => {
    if (busy.current) return;
    const lifetime = generation.current;
    busy.current = true; setPending(true); setFeedback({ message: "正在保存…" });
    try {
      await settingsResponse(await diagnosticFetch(`/api/choirs/${choirId}/shared-layers${path}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      if (lifetime !== generation.current) return;
      setFeedback({ message });
      if (method === "POST") setNewName("");
      retryLoad();
    } catch (error) {
      if (lifetime === generation.current) setFeedback({ message: settingsError(error, "保存失败，请重试。"), failed: true });
    } finally {
      if (lifetime === generation.current) { busy.current = false; setPending(false); }
    }
  };

  return <div className="app-page">
    <AppHeader actions={<Link className="header-action" to={`/choirs/${choirId}`}>返回云盘</Link>} />
    <main className="page-shell settings-page settings-ux">
      <header className="settings-heading">
        <p className="eyebrow">云盘管理 · {driveName}</p><h1>共享层管理</h1>
        <p className="settings-copy">适用于此云盘的所有乐谱。选择一个层，修改名称、颜色和编辑权限。</p>
      </header>
      <SettingsFeedback loading={loading} loadError={loadError} message={null} retry={retryLoad} />
      {feedback && <p role={feedback.failed ? "alert" : "status"}>{feedback.message}</p>}
      {!loadError && <>
        <section className="settings-card" aria-label="共享层管理列表" aria-busy={loading || pending}>
          {layers.map((layer, index) => <article className="settings-layer-row settings-layer-row--management" key={layer.slot}>
            <Link className="settings-layer-link" to={`/choirs/${choirId}/shared-layers/${layer.slot}`}>
              <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
              <strong>{sharedLayerLabel(layer.slot, layer.name)}</strong>
              <small>{layer.active ? `已授权 ${layer.grantedMemberCount} 位成员` : "已停用 · 笔记保留"}</small><span aria-hidden="true">›</span>
            </Link>
            <div className="layer-order-actions">
              <button aria-label={`上移 ${sharedLayerLabel(layer.slot, layer.name)}`} disabled={pending || loading || index === 0} onClick={() => void change(`/${layer.slot}/order`, "PUT", { direction: "up" }, "顺序已保存。") }><ArrowUp size={18} aria-hidden="true" /></button>
              <button aria-label={`下移 ${sharedLayerLabel(layer.slot, layer.name)}`} disabled={pending || loading || index === layers.length - 1} onClick={() => void change(`/${layer.slot}/order`, "PUT", { direction: "down" }, "顺序已保存。") }><ArrowDown size={18} aria-hidden="true" /></button>
            </div>
          </article>)}
        </section>
        <form className="layer-create-form" onSubmit={event => { event.preventDefault(); if (newName.trim()) void change("", "POST", { name: newName.trim(), defaultColor: "#3157a4" }, "共享层已创建。"); }}>
          <label>新共享层名称<input value={newName} maxLength={60} required disabled={pending || loading} onChange={event => setNewName(event.target.value)} /></label>
          <button className="secondary-button" disabled={pending || loading}>新增共享层</button>
        </form>
      </>}
    </main>
  </div>;
}
