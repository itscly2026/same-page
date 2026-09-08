import { loginHref } from "../auth/login-return";
import { resolveSharedLayerPreference, annotationLayerListResponseSchema } from "../../shared/annotations";
import { useEffect, useRef, useState } from "react";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { PersonalLayerCard } from "./personal-layer-card";
import { Link } from "react-router-dom";
import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import { syncAnnotations } from "../annotations/sync";
import { updateCachedLayer } from "../annotations/annotation-state";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import "./reader-ux.css";

type PreferenceChange = { layer: AnnotationLayerSummary; subscribed?: boolean | null; colorOverride?: string | null };

export function ReaderLayerPanel({ workspace, layers, signedIn }: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  signedIn: boolean;
}) {
  const [creationId, setCreationId] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleted, setDeleted] = useState<AnnotationLayerSummary[]>([]);
  const [personalRetry, setPersonalRetry] = useState<(() => Promise<void>) | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState<PreferenceChange[]>([]);
  const busy = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
  return () => { active.current = false; };
  }, []);
  const sharedLayers = layers.filter((layer) => layer.kind === "shared");
  const personalLayers = layers.filter((layer) => layer.kind === "personal" && layer.canEdit);
  const publishedLayers = layers.filter(layer => layer.kind === "personal" && !layer.canEdit);
  const overriddenLayers = sharedLayers.filter((layer) => layer.scoreSubscriptionOverride !== null || layer.scoreColorOverride != null);

  const save = async (changes: PreferenceChange[]) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setMessage("正在保存本谱显示设置…");
    setFailed([]);
    setPersonalRetry(null);
    const results = await Promise.allSettled(changes.map(async ({ layer, subscribed, colorOverride }) => {
      if (!layer.sharedSlot) return;
      await assertLocalWorkspaceActive(workspace);
      if (signedIn) {
        const response = await diagnosticFetch(
          `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/shared-layers/${layer.sharedSlot}/preference`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subscribed, colorOverride }),
          },
        );
        if (!response.ok) throw new Error("score_preference_update_failed");
      }
      const scoreSubscriptionOverride = subscribed === undefined ? layer.scoreSubscriptionOverride : subscribed;
      const scoreColorOverride = colorOverride === undefined ? layer.scoreColorOverride ?? null : colorOverride;
      await updateCachedLayer(workspace, layer.id, {
        scoreSubscriptionOverride, scoreColorOverride,
        ...resolveSharedLayerPreference({ productDefaultColor: "#dc2626", adminDefaultColor: layer.adminDefaultColor,
          driveSubscribed: layer.driveSubscribed, driveColorOverride: layer.driveColorOverride,
          scoreSubscriptionOverride, scoreColorOverride }),
      });
    }));
    if (!active.current) return;
    const failures = changes.filter((_, index) => results[index]?.status === "rejected");
    setFailed(failures);
    setMessage(failures.length
      ? `${failures.length === changes.length ? "未能保存" : `已保存 ${changes.length - failures.length} 项；未能保存`}：${failures.map(({ layer }) => layer.name).join("、")}。未保存的显示设置保持原样，请重试。`
      : "");
    busy.current = false;
    setPending(false);
  };

  const refreshDeleted = async () => {
    await assertLocalWorkspaceActive(workspace);
    const response = await diagnosticFetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/layers?state=deleted`);
    if (!response.ok) throw new Error("deleted_layers_refresh_failed");
    const result = annotationLayerListResponseSchema.parse(await response.json());
    await assertLocalWorkspaceActive(workspace);
    if (active.current) setDeleted(result.layers.filter(layer => layer.kind === "personal" && layer.canEdit && layer.deletedAt));
  };

  const personalRequest = async (path: string, method: string, body?: unknown) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setMessage(""); setFailed([]); setPersonalRetry(null);
    let confirmed = false;
    let changed = false;
    try {
      await assertLocalWorkspaceActive(workspace);
      const response = await diagnosticFetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/${path}`, {
        method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      await assertLocalWorkspaceActive(workspace);
      changed = response.status === 409;
      if (!response.ok) throw new Error("personal_layer_update_failed");
      confirmed = true;
      if (method === "GET") {
        const result = annotationLayerListResponseSchema.parse(await response.json());
        if (active.current) {
          setDeleted(result.layers.filter(layer => layer.kind === "personal" && layer.canEdit && layer.deletedAt));
          setManaging(true);
        }
      } else {
        if (active.current && method === "POST" && path === "personal-layers") { setCreationId(null); setNewName(""); }
        await syncAnnotations(workspace, { pull: true });
        if (managing) await refreshDeleted();
      }
      return true;
    } catch {
      if (active.current) {
        setMessage("未能完成保存或刷新，请检查网络后重试。若内容已改变，请刷新图层后再操作。");
        setPersonalRetry(() => confirmed || changed ? async () => {
          setPending(true);
          try { await syncAnnotations(workspace, { pull: true }); if (managing) await refreshDeleted(); if (active.current) { setMessage(changed ? "图层已刷新，请核对当前状态后重新操作。" : ""); setPersonalRetry(null); } }
          catch { if (active.current) setMessage("图层刷新失败，请重试。"); }
          finally { if (active.current) setPending(false); }
        } : async () => { await personalRequest(path, method, body); });
      }
      return false;
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };

  return (
    <section className="reader-layer-panel" aria-label="看哪些笔记" aria-busy={pending}>
      <p className="reader-layer-help">仅这份谱 · 仅我。更改自动保存。{signedIn ? <Link to={`/choirs/${workspace.choirId}/preferences`}>此云盘的默认显示</Link> : <Link to={loginHref(`/choirs/${workspace.choirId}/scores/${workspace.scoreId}`, "layers")}>登录后设置默认显示</Link>}</p>
      <div className="layer-section">
        <div className="layer-section__heading">
          <div><h3>共享层</h3></div>
          <div className="layer-section__actions">
            <span>{sharedLayers.filter((layer) => layer.subscribed).length} / {sharedLayers.length}</span>
            {overriddenLayers.length > 0 ? (
              <Button className="layer-section__restore" isDisabled={pending}
                aria-description="将这份乐谱的所有共享层恢复为我的云盘默认显示设置"
                onPress={() => void save(overriddenLayers.map((layer) => ({ layer, subscribed: null, colorOverride: null })))}>
                使用云盘默认
              </Button>
            ) : null}
          </div>
        </div>
        {message ? <div className="reader-layer-feedback" data-error={failed.length > 0 || undefined}>
          <p role={failed.length ? "alert" : "status"}>{message}</p>
          {personalRetry ? <Button isDisabled={pending} onPress={() => void personalRetry()}>重试</Button> : null}
          {failed.length > 0 ? <Button isDisabled={pending} onPress={() => void save(failed)}>重试未保存项</Button> : null}
        </div> : null}
        <div className="layer-card-list">
          {sharedLayers.map((layer) => (
            <article className="layer-card" key={layer.id}>
              <div className="layer-card__main reader-layer-row">
                <label className="reader-layer-toggle">
                  <input aria-label={`显示 ${layer.name}`}
                    checked={layer.subscribed} disabled={pending} type="checkbox"
                    onChange={(event) => void save([{ layer, subscribed: event.target.checked }])} />
                  <span className="layer-card__identity"><strong>
                    {layer.name}
                  </strong></span>
                </label>
                <input type="color" aria-label={`${layer.name}颜色`} value={layer.displayColor} disabled={pending}
                  onChange={event => void save([{ layer, colorOverride: event.target.value }])} />
              </div>
            </article>
          ))}
        </div>
      </div>
      {(personalLayers.length > 0 || signedIn) && <div className="layer-section layer-section--personal">
        <div className="layer-section__heading"><h3>个人层</h3></div>
        {personalLayers.map(layer => <PersonalLayerCard key={layer.id} layer={layer} workspace={workspace} pending={pending || !signedIn}
          onChange={change => personalRequest(`personal-layers/${layer.id}`, "PUT", { ...change, expectedRevision: layer.revision ?? 0 })}
          onSubscribe={subscribed => void personalRequest(`personal-layers/${layer.id}/subscription`, "PUT", { subscribed })} />)}
        {signedIn && <>
          <div className="personal-layer-footer">
            {!creationId && <Button className="personal-layer-create" isDisabled={pending} onPress={() => setCreationId(crypto.randomUUID())}>＋ 新建个人层</Button>}
            <Button className="personal-layer-deleted" isDisabled={pending} aria-expanded={managing}
              onPress={() => { if (managing) setManaging(false); else void personalRequest("layers?state=deleted", "GET"); }}>已删除个人层</Button>
          </div>
          {creationId && <form onSubmit={event => { event.preventDefault(); void personalRequest("personal-layers", "POST", { id: creationId, name: newName.trim() }); }}>
            <input aria-label="新个人层名称" placeholder="例如：排练记录" required maxLength={60} value={newName} onChange={event => setNewName(event.target.value)} />
            <button disabled={pending || !newName.trim()}>新建个人层</button>
          <Button isDisabled={pending} onPress={() => setCreationId(null)}>取消</Button>
          </form>}
          {managing && deleted.length === 0 && <p className="reader-layer-help" role="status">没有可恢复的个人层。</p>}
          {managing && deleted.map(layer => <div key={layer.id}>{layer.name}<Button isDisabled={pending}
            onPress={() => void personalRequest(`personal-layers/${layer.id}`, "PUT", { action: "restore", expectedRevision: layer.revision })}>恢复 {layer.name}</Button></div>)}
        </>}
      </div>}
      {publishedLayers.length ? <div className="layer-section"><h3>成员分享</h3>
        <p className="reader-layer-help">显示作者的最新笔记，仅供阅读。</p>
        {publishedLayers.map(layer => <label className="reader-layer-toggle" key={layer.id}>
          <input type="checkbox" aria-label={`显示 ${layer.name}`} checked={layer.subscribed} disabled={pending}
            onChange={event => void personalRequest(`personal-layers/${layer.id}/subscription`, "PUT", { subscribed: event.target.checked })} />
          <span className="layer-color-preview" style={{ background: layer.displayColor }} />{layer.name}
        </label>)}
      </div> : null}
    </section>
  );
}
