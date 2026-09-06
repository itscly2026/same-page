import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [view, setView] = useState<"current" | "deleted">("current");
  const [deleting, setDeleting] = useState<SharedLayerManagementSummary | null>(null);
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
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layers?state=${view}`, { signal: controller.signal })
      .then(settingsResponse).then(value => {
        const body = sharedLayerManagementResponseSchema.parse(value);
        if (controller.signal.aborted) return;
        setDriveName(body.drive.name); setLayers(body.layers); setLoading(false);
      }).catch(error => {
        if (!controller.signal.aborted) { setLoadError(settingsError(error, "暂时无法读取共享层管理设置。")); setLoading(false); }
      });
    return () => controller.abort();
  }, [choirId, loadAttempt, view]);

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
      setDeleting(null);
      retryLoad();
    } catch (error) {
      if (lifetime === generation.current) {
        setFeedback({ message: settingsError(error, "未能确认操作结果，正在重新查询。请核对当前列表后重试；可能已由其他管理员更改或超过恢复期限。"), failed: true });
        setDeleting(null);
        retryLoad();
      }
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
      <div className="layer-order-actions">
        <button className="secondary-button" disabled={pending || view === "current"} onClick={() => { setLayers([]); setLoading(true); setView("current"); }}>当前共享层</button>
        <button className="secondary-button" disabled={pending || view === "deleted"} onClick={() => { setLayers([]); setLoading(true); setView("deleted"); }}>已删除层</button>
      </div>
      {view === "deleted" && <p className="settings-copy">删除影响当前云盘全部乐谱。30 天内恢复原层及其批注、授权和阅读偏好，之后永久清理。恢复不会恢复已终止的成员关系。</p>}
      {!loadError && <>
        <section className="settings-card" aria-label="共享层管理列表" aria-busy={loading || pending}>
          {!loading && !layers.length && <p>{view === "deleted" ? "没有已删除的共享层。" : "没有共享层。"}</p>}
          {layers.map((layer, index) => <article className="settings-layer-row settings-layer-row--management" key={layer.slot}>
            {view === "deleted" ? <div className="settings-layer-link">
              <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
              <strong>{sharedLayerLabel(layer.slot, layer.name)}</strong>
              <small>{layer.recoverUntil !== null && layer.recoverUntil > now
                ? `恢复截止：${new Date(layer.recoverUntil).toLocaleString()} · 恢复后${layer.active ? "启用" : "停用"}`
                : "已到期 · 不可恢复，等待永久清理"}</small>
              <button className="secondary-button" disabled={pending || loading || layer.recoverUntil === null || layer.recoverUntil <= now}
                onClick={() => void change(`/${layer.slot}/lifecycle`, "POST", { action: "restore", expectedRevision: layer.revision }, "原共享层已恢复，原有启用或停用状态保留。")}>恢复</button>
            </div> : <>
            <Link className="settings-layer-link" to={`/choirs/${choirId}/shared-layers/${layer.slot}`}>
              <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
              <strong>{sharedLayerLabel(layer.slot, layer.name)}</strong>
              <small>{layer.active ? `已授权 ${layer.grantedMemberCount} 位成员` : "已停用 · 笔记保留"}</small><span aria-hidden="true">›</span>
            </Link>
            <div className="layer-order-actions">
              <button aria-label={`上移 ${sharedLayerLabel(layer.slot, layer.name)}`} disabled={pending || loading || index === 0} onClick={() => void change(`/${layer.slot}/order`, "PUT", { direction: "up" }, "顺序已保存。") }><ArrowUp size={18} aria-hidden="true" /></button>
              <button aria-label={`下移 ${sharedLayerLabel(layer.slot, layer.name)}`} disabled={pending || loading || index === layers.length - 1} onClick={() => void change(`/${layer.slot}/order`, "PUT", { direction: "down" }, "顺序已保存。") }><ArrowDown size={18} aria-hidden="true" /></button>
              <button className="text-button" disabled={pending || loading} onClick={() => setDeleting(layer)} aria-label={`删除 ${sharedLayerLabel(layer.slot, layer.name)}`}>删除</button>
            </div>
            </>}
          </article>)}
        </section>
        {view === "current" && <form className="layer-create-form" onSubmit={event => { event.preventDefault(); if (newName.trim()) void change("", "POST", { name: newName.trim(), defaultColor: "#3157a4" }, "共享层已创建。"); }}>
          <label>新共享层名称<input type="text" value={newName} maxLength={60} required disabled={pending || loading} onChange={event => setNewName(event.target.value)} /></label>
          <button className="secondary-button" disabled={pending || loading}>新增共享层</button>
        </form>}
      </>}
    </main>
    <ModalOverlay className="modal-overlay" isOpen={deleting !== null} isDismissable={!pending} onOpenChange={open => { if (!open && !pending) setDeleting(null); }}>
      <Modal className="app-modal app-modal--compact"><Dialog className="app-dialog">
        <Heading slot="title">删除共享层「{deleting ? sharedLayerLabel(deleting.slot, deleting.name) : ""}」？</Heading>
        <p>这会删除当前云盘全部乐谱上的此共享层，并立即隐藏其批注、停止云端编辑。</p>
        <p>30 天内可在“已删除层”恢复原层、批注、授权和阅读偏好；到期后永久清理。停用则保留内容且没有清理期限。</p>
        <p>断网设备在重新联网确认层状态后停止上传，本机未同步草稿会保留。</p>
        <div className="dialog-actions">
          <Button className="secondary-button" isDisabled={pending} onPress={() => setDeleting(null)}>取消</Button>
          <Button className="danger-button" isDisabled={pending} onPress={() => {
            if (deleting) void change(`/${deleting.slot}/lifecycle`, "POST", { action: "delete", expectedRevision: deleting.revision }, "共享层已删除，可在已删除层入口查看并恢复。");
          }}>{pending ? "正在删除…" : "删除整个共享层"}</Button>
        </div>
      </Dialog></Modal>
    </ModalOverlay>
  </div>;
}
