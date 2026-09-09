import { ViewSelector } from "../components/view-selector";
import { useReadResource } from "../settings/use-read-resource";
import { driveManagementSchema } from "../../shared/drive-management";
import { runSettingsMutation, settingsMutationMessage } from "../settings/settings-mutation";
import { captureLocalWorkspaceSession, resolveLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";
import { applySharedLayerAvailability } from "../annotations/annotation-state";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { sharedLayerAvailabilitySchema, sharedLayerManagementResponseSchema, type SharedLayerManagementSummary } from "../../shared/annotations";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { TaskHeader } from "../components/task-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function SharedLayerManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <SharedLayerAccess key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} userId={session.data?.user.id ?? null} />;
}

function SharedLayerAccess({ choirId, userId }: { choirId: string; userId: string | null }) {
  const resource = useReadResource(`${userId}:${choirId}:layer-access`, async signal =>
    driveManagementSchema.parse(await settingsResponse(await diagnosticFetch(`/api/choirs/${choirId}/management`, { signal }))));
  const overview = resource.data;
  const error = resource.error ? settingsError(resource.error, "无法更新共享层，请重试。") : null;
  if (overview?.capabilities.operations.operations.includes("configureLayers")) return <SharedLayerManagement choirId={choirId} userId={userId} authorized={resource.canMutate} accessError={error} retryAccess={resource.refresh} />;
  return <div className="app-page"><TaskHeader title="共享层" backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page settings-ux">
    <p>{overview?.name}</p><p>此云盘全部乐谱的共享笔记层。查看配置不授予编辑或管理权限。</p>
    {overview ? <><ul className="shared-layer-summary">{overview.layers.map(layer => <li key={layer.slot}><strong>{layer.name}</strong><span>{layer.active ? "启用" : "停用"}</span></li>)}</ul><p>需要调整时，可查找有共享层配置或授权权限的人。</p><Link to={`/choirs/${choirId}/memberships`}>查看成员与权限</Link></> : <SettingsFeedback loading={!error} loadError={error} message={null} retry={() => void resource.refresh().catch(() => undefined)} />}
  </main></div>;
}

function SharedLayerManagement({ choirId, userId, authorized, accessError, retryAccess }: { choirId: string; userId: string | null; authorized: boolean; accessError: string | null; retryAccess: () => Promise<void> }) {
  const workspaceRef = useRef<LocalWorkspace | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const [view, setView] = useState<"current" | "deleted">("current");
  const [deleting, setDeleting] = useState<SharedLayerManagementSummary | null>(null);
  const [newName, setNewName] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [feedback, setFeedback] = useState<{ message: string; failed?: boolean; refreshFailed?: boolean } | null>(null);
  const generation = useSettingsLifetime();
  const resource = useReadResource(`${userId}:${choirId}:shared-layers:${view}`, async signal => {
    if (!userId) throw new Error("authentication_required");
    const workspace = await captureLocalWorkspaceSession(await resolveLocalWorkspace({ choirId, scoreId: "shared-layer-management", authenticatedUserId: userId, signal }));
    signal.throwIfAborted(); workspaceRef.current = workspace;
    const body = sharedLayerManagementResponseSchema.parse(await settingsResponse(await diagnosticFetch(`/api/choirs/${choirId}/shared-layers?state=${view}`, { signal })));
    signal.throwIfAborted();
    if (!await applySharedLayerAvailability(workspace, body)) throw new Error("shared_layer_state_changed");
    return body;
  });
  const layers = resource.data?.layers ?? [];
  const driveName = resource.data?.drive.name ?? "";
  const loading = !authorized || !resource.canMutate;
  const loadError = accessError ?? (resource.error ? settingsError(resource.error, "暂时无法更新共享层，已有内容已保留。") : null);
  const retryLoad = () => { void Promise.allSettled([retryAccess(), resource.refresh()]); };

  const change = async (path: string, method: "POST" | "PUT", body: object, message: string) => {
    if (busy.current || loading) return;
    const lifetime = generation.current;
    const workspace = workspaceRef.current;
    busy.current = true; setPending(true); setFeedback(null);
    const result = await runSettingsMutation(
      () => diagnosticFetch(`/api/choirs/${choirId}/shared-layers${path}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
      async response => {
        if (lifetime !== generation.current) return;
        if (path.endsWith("/lifecycle")) {
          const state = sharedLayerAvailabilitySchema.parse(await response.json());
          if (!workspace || !await applySharedLayerAvailability(workspace, state)) throw new Error("shared_layer_state_changed");
        }
        await resource.refresh();
      },
    );
    if (lifetime !== generation.current) return;
    setFeedback(result.kind === "saved" ? null : { message: settingsMutationMessage(result, message), failed: true, refreshFailed: result.kind === "saved-refresh-failed" });
    if ((result.kind === "saved" || result.kind === "saved-refresh-failed") && method === "POST") setNewName("");
    setDeleting(null);
    if (result.kind === "revoked") resource.clear();
    else if (result.kind === "unconfirmed" || result.kind === "failed") await resource.refresh().catch(() => undefined);
    busy.current = false; setPending(false);
  };

  return <div className="app-page">
    <TaskHeader title={"共享层"} backTo={`/choirs/${choirId}`} />
    <main className="page-shell settings-page settings-ux">
      <header className="settings-heading">
        <p className="eyebrow">云盘设置 · {driveName}</p>
        <p className="settings-copy">适用于此云盘的所有乐谱。选择一个层，修改名称、颜色或启用状态。编辑权限在“成员与权限”设置。</p>
      </header>
      <SettingsFeedback loading={resource.loading} loadError={loadError} message={null} retry={retryLoad} />
      {feedback && <p role={feedback.failed ? "alert" : "status"}>{feedback.message}</p>}
      <ViewSelector<"current" | "deleted"> label="共享层视图" value={view} pending={pending} onChange={setView} options={[{ id: "current", label: "当前共享层" }, { id: "deleted", label: "已删除层" }]} />
      {view === "deleted" && <p className="settings-copy">删除影响当前云盘全部乐谱。30 天内恢复原层及其笔记、授权和阅读偏好，之后永久清理。恢复不会恢复已终止的成员关系。</p>}
      {resource.data && <>
        <section className="settings-card" aria-label="共享层管理列表" aria-busy={loading || pending}>
          {!loading && !layers.length && <p>{view === "deleted" ? "没有已删除的共享层。" : "没有共享层。"}</p>}
          {layers.map((layer, index) => <article className="settings-layer-row settings-layer-row--management" key={layer.slot}>
            {view === "deleted" ? <div className="settings-layer-link">
              <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
              <strong>{layer.name}</strong>
              <small>{layer.recoverUntil !== null && layer.recoverUntil > now
                ? `恢复截止：${new Date(layer.recoverUntil).toLocaleString()} · 恢复后${layer.active ? "启用" : "停用"}`
                : "已到期 · 不可恢复，等待永久清理"}</small>
              <button className="secondary-button" disabled={pending || loading || layer.recoverUntil === null || layer.recoverUntil <= now}
                onClick={() => void change(`/${layer.slot}/lifecycle`, "POST", { action: "restore", expectedRevision: layer.revision }, "原共享层已恢复，原有启用或停用状态保留。")}>恢复</button>
            </div> : <>
            <Link className="settings-layer-link" to={`/choirs/${choirId}/shared-layers/${layer.slot}`}>
              <span className="settings-layer-swatch" style={{ background: layer.defaultColor }} />
              <strong>{layer.name}</strong>
              <small>{layer.active ? `已授权 ${layer.grantedMemberCount} 位成员` : "已停用 · 笔记保留"}</small><span aria-hidden="true">›</span>
            </Link>
            <div className="layer-order-actions">
              <button aria-label={`上移 ${layer.name}`} disabled={pending || loading || index === 0} onClick={() => void change(`/${layer.slot}/order`, "PUT", { direction: "up" }, "顺序已保存。") }><ArrowUp size={18} aria-hidden="true" /></button>
              <button aria-label={`下移 ${layer.name}`} disabled={pending || loading || index === layers.length - 1} onClick={() => void change(`/${layer.slot}/order`, "PUT", { direction: "down" }, "顺序已保存。") }><ArrowDown size={18} aria-hidden="true" /></button>
              <button className="text-button" disabled={pending || loading} onClick={() => setDeleting(layer)} aria-label={`删除 ${layer.name}`}>删除</button>
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
      <Modal className="app-modal app-modal--compact"><Dialog className="app-dialog" exitDisabled={pending}>
        <Heading slot="title">删除共享层「{deleting ? deleting.name : ""}」？</Heading>
        <p>这会删除当前云盘全部乐谱上的此共享层，并立即隐藏其笔记、停止云端编辑。</p>
        <p>30 天内可在“已删除层”恢复原层、笔记、授权和阅读偏好；到期后永久清理。停用则保留内容且没有清理期限。</p>
        <p>断网设备在重新联网确认层状态后停止上传，本机未同步草稿会保留。</p>
        <div className="dialog-actions">
          <Button className="secondary-button" isDisabled={pending} onPress={() => setDeleting(null)}>取消</Button>
          <Button className="primary-button" isDisabled={pending} onPress={() => {
            if (deleting) void change(`/${deleting.slot}/lifecycle`, "POST", { action: "delete", expectedRevision: deleting.revision }, "共享层已删除，可在已删除层入口查看并恢复。");
          }}>{pending ? "正在删除…" : "删除整个共享层"}</Button>
        </div>
      </Dialog></Modal>
    </ModalOverlay>
  </div>;
}
