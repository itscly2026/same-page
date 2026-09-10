import { isLocalExperience } from "../annotations/guest-notes";
import { useReadingPreferenceProjection } from "./reading-preference-intents";
import { loginHref } from "../auth/login-return";
import { annotationLayerListResponseSchema } from "../../shared/annotations";
import { useEffect, useId, useRef, useState } from "react";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { PersonalLayerCard } from "./personal-layer-card";
import { Link } from "react-router-dom";
import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import { syncAnnotations } from "../annotations/sync";
import { useReadingPreferences } from "./use-reading-preferences";
import { assertLocalWorkspaceActive, type LocalWorkspace } from "../platform/local-workspace";
import "./reader-ux.css";

type PreferenceChange = { layer: AnnotationLayerSummary; subscribed?: boolean | null; colorOverride?: string | null };

export function ReaderLayerPanel({ workspace, layers: storedLayers, signedIn }: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  signedIn: boolean;
}) {
  const visibilityPrefix = useId();
  const managementTrigger = useRef<HTMLButtonElement>(null);
  const [creationId, setCreationId] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [newName, setNewName] = useState("");
  const [deletedLoaded, setDeletedLoaded] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [deleted, setDeleted] = useState<AnnotationLayerSummary[]>([]);
  const [personalRetry, setPersonalRetry] = useState<(() => Promise<void>) | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [feedbackName, setFeedbackName] = useState("");
  const [feedbackTarget, setFeedbackTarget] = useState<string | null>(null);
  const [feedbackInManagement, setFeedbackInManagement] = useState(false);
  const preferences = useReadingPreferences(workspace, signedIn);
  const projectedLayers = useReadingPreferenceProjection(workspace, storedLayers);
  const layers = preferences.projectLayers(projectedLayers);
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

  const save = (changes: PreferenceChange[]) => Promise.all(changes.map(({ layer, ...change }) =>
    preferences.save({ kind: "shared", id: layer.sharedSlot! }, change)));
  const preferenceFeedback = (kind: "shared" | "personal", id: string) => {
    const result = preferences.feedback({ kind, id });
    return result ? <div className="reader-layer-feedback"><p role="status">{result.message}</p>
      {result.retry && <Button onPress={result.retry}>重试</Button>}</div> : null;
  };

  const refreshDeleted = async () => {
    await assertLocalWorkspaceActive(workspace);
    const response = await diagnosticFetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/layers?state=deleted`);
    if (!response.ok) throw new Error("deleted_layers_refresh_failed");
    const result = annotationLayerListResponseSchema.parse(await response.json());
    await assertLocalWorkspaceActive(workspace);
    if (active.current) { setDeleted(result.layers.filter(layer => layer.kind === "personal" && layer.canEdit && layer.deletedAt)); setDeletedLoaded(true); }
  };

  const personalRequest = async (path: string, method: string, body?: unknown, inManagement = false) => {
    if (busy.current || needsRefresh) return;
    busy.current = true; setPending(true); setMessage(""); setPersonalRetry(null);
    const target = path.startsWith("personal-layers/") ? path.split("/")[1] : null;
    setFeedbackTarget(target); setFeedbackName([...layers, ...deleted].find(layer => layer.id === target)?.name ?? ""); setFeedbackInManagement(inManagement);
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
      confirmed = method !== "GET";
      if (method === "GET") {
        const result = annotationLayerListResponseSchema.parse(await response.json());
        if (active.current) {
          setDeleted(result.layers.filter(layer => layer.kind === "personal" && layer.canEdit && layer.deletedAt));
          setDeletedLoaded(true); setManaging(true);
        }
      } else {
        if (active.current && method === "POST" && path === "personal-layers") { setCreationId(null); setNewName(""); }
        await syncAnnotations(workspace, { pull: true });
        if (managing) await refreshDeleted();
      }
      return true;
    } catch {
      if (active.current) {
        setNeedsRefresh(confirmed || changed);
        setMessage(method === "GET" ? "个人层列表读取失败，请重试。" : confirmed ? "修改已保存，内容刷新失败。请重试刷新。" : "修改尚未确认，请检查网络后重试。");
        setPersonalRetry(() => confirmed || changed ? async () => {
          setPending(true);
          try { await syncAnnotations(workspace, { pull: true }); if (managing) await refreshDeleted(); if (active.current) { setMessage(changed ? "图层已刷新，请核对当前状态后重新操作。" : ""); setPersonalRetry(null); setNeedsRefresh(false); } }
          catch { if (active.current) setMessage("图层刷新失败，请重试。"); }
          finally { if (active.current) setPending(false); }
        } : async () => { await personalRequest(path, method, body, inManagement); });
      }
      return false;
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };

  const mutationFeedback = (target: string | null, inManagement = false, showName = false) => feedbackTarget === target && feedbackInManagement === inManagement && (pending || message)
    ? <div className="reader-layer-feedback">{showName && feedbackName && <strong>{feedbackName}</strong>}<p role="status">{pending ? "正在处理…" : message}</p>{personalRetry && <Button isDisabled={pending} onPress={() => void personalRetry()}>重试</Button>}</div> : null;

  const managementOpen = managing;
  const missingFeedbackRow = feedbackTarget !== null && !(feedbackInManagement ? (managing ? deleted : []) : personalLayers).some(layer => layer.id === feedbackTarget);
  const feedbackOutsideManagement = feedbackInManagement && !managementOpen;

  return (
    <section className="reader-layer-panel" aria-label="看哪些笔记" aria-busy={pending}>
      <p className="reader-layer-help">仅影响你在这份谱上的显示，更改自动保存。</p><div className="reader-layer-preferences">{isLocalExperience(workspace) ? <span>体验显示仅保存在此浏览器</span> : signedIn ? <Link to={`/choirs/${workspace.choirId}/preferences`}>设置此云盘的默认显示</Link> : <Link to={loginHref(`/choirs/${workspace.choirId}/scores/${workspace.scoreId}`, "layers")}>登录后设置默认显示</Link>}</div>
      <div className="layer-section">
        <div className="layer-section__heading">
          <div><h3>共享层</h3></div>
          <div className="layer-section__actions">
            <span>显示 {sharedLayers.filter((layer) => layer.subscribed).length} / {sharedLayers.length}</span>
            {overriddenLayers.length > 0 ? (
              <Button className="layer-section__restore"
                aria-description="将这份乐谱的所有共享层恢复为我的云盘默认显示设置"
                onPress={() => void save(overriddenLayers.map((layer) => ({ layer, subscribed: null, colorOverride: null })))}>
                使用云盘默认
              </Button>
            ) : null}
          </div>
        </div>
        <div className="layer-card-list">
          {sharedLayers.map((layer) => (
            <article className="layer-card" key={layer.id}>
              <div className="layer-card__main reader-layer-row">
                <label className="layer-row__name" htmlFor={`${visibilityPrefix}-${layer.id}`}><strong>{layer.name}</strong></label>
                <input className="layer-row__accessory" type="color" aria-label={`${layer.name}颜色`} value={layer.displayColor}
                  onChange={event => void save([{ layer, colorOverride: event.target.value }])} />
                <label className="layer-row__visibility"><input id={`${visibilityPrefix}-${layer.id}`} aria-label={`显示 ${layer.name}`}
                  checked={layer.subscribed} type="checkbox"
                  onChange={event => void save([{ layer, subscribed: event.target.checked }])} /></label>
              </div>
              {preferenceFeedback("shared", layer.sharedSlot!)}
            </article>
          ))}
        </div>
      </div>
      {(personalLayers.length > 0 || signedIn) && <div className="layer-section layer-section--personal">
        <div className="layer-section__heading"><h3>个人层</h3>{signedIn && <Button ref={managementTrigger} className="personal-layer-more" isDisabled={pending || needsRefresh} onPress={() => { setManaging(true); void personalRequest("layers?state=deleted", "GET", undefined, true); }}>已删除个人层</Button>}</div>
        {mutationFeedback(null)}{(feedbackOutsideManagement || (!feedbackInManagement && missingFeedbackRow)) && mutationFeedback(feedbackTarget, feedbackInManagement, true)}
        {personalLayers.map(layer => <div key={layer.id}><PersonalLayerCard key={layer.id} layer={layer} workspace={workspace} pending={pending} blocked={!signedIn || needsRefresh} feedback={mutationFeedback(layer.id)}
          onChange={change => personalRequest(`personal-layers/${layer.id}`, "PUT", { ...change, expectedRevision: layer.revision ?? 0 })}
          onSubscribe={subscribed => void preferences.save({ kind: "personal", id: layer.id }, { subscribed })} />{preferenceFeedback("personal", layer.id)}</div>)}
        {signedIn && <>
          <div className="personal-layer-footer">
            {!creationId && <Button className="personal-layer-create" isDisabled={pending || needsRefresh} onPress={() => setCreationId(crypto.randomUUID())}>＋ 新建个人层</Button>}

          </div>
          {creationId && <form onSubmit={event => { event.preventDefault(); void personalRequest("personal-layers", "POST", { id: creationId, name: newName.trim() }); }}>
            <input aria-label="新个人层名称" placeholder="例如：排练记录" required maxLength={60} value={newName} onChange={event => setNewName(event.target.value)} />
            <button disabled={pending || needsRefresh || !newName.trim()}>新建个人层</button>
          <Button isDisabled={pending} onPress={() => setCreationId(null)}>取消</Button>
          </form>}
          {managing && <section className="personal-layer-management" aria-label="已删除个人层">
            <div className="layer-section__heading"><h4>已删除个人层</h4><Button onPress={() => { setManaging(false); requestAnimationFrame(() => managementTrigger.current?.focus()); }}>关闭</Button></div>
            {mutationFeedback(null, true)}{feedbackInManagement && missingFeedbackRow && mutationFeedback(feedbackTarget, true, true)}{managing && pending && <p role="status">正在更新个人层…</p>}
          {managing && deletedLoaded && !pending && deleted.length === 0 && <p className="reader-layer-help" role="status">没有可恢复的个人层。</p>}
          {managing && deleted.map(layer => <div key={layer.id}>{layer.name}<Button isDisabled={pending || needsRefresh}
            onPress={() => void personalRequest(`personal-layers/${layer.id}`, "PUT", { action: "restore", expectedRevision: layer.revision }, true)}>恢复 {layer.name}</Button>{mutationFeedback(layer.id, true)}</div>)}
          </section>}

        </>}
      </div>}
      {publishedLayers.length ? <div className="layer-section"><h3>成员分享</h3>
        <p className="reader-layer-help">显示作者的最新笔记，仅供阅读。</p>
        <div className="layer-card-list">{publishedLayers.map(layer => <article className="layer-card" key={layer.id}>
          <div className="layer-card__main reader-layer-row"><label className="layer-row__name" htmlFor={`${visibilityPrefix}-${layer.id}`}><strong>{layer.name}</strong></label>
            <label className="layer-row__visibility"><input id={`${visibilityPrefix}-${layer.id}`} type="checkbox" aria-label={`显示 ${layer.name}`} checked={layer.subscribed}
              onChange={event => void preferences.save({ kind: "personal", id: layer.id }, { subscribed: event.target.checked })} /></label>
          </div>{preferenceFeedback("personal", layer.id)}
        </article>)}</div>
      </div> : null}
    </section>
  );
}
