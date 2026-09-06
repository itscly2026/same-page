import { sharedLayerLabel, sharedLayerDisplayName, sharedLayerPrefix } from "../../shared/annotations";
import { useEffect, useRef, useState } from "react";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import { syncAnnotations } from "../annotations/sync";
import { updateCachedLayer } from "../annotations/annotation-state";
import type { LocalWorkspace } from "../platform/local-workspace";
import "./reader-ux.css";

type PreferenceChange = { layer: AnnotationLayerSummary; subscribed: boolean | null };

export function ReaderLayerPanel({ workspace, layers, signedIn }: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  signedIn: boolean;
}) {
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
  const personalLayer = layers.find((layer) => layer.kind === "personal" && layer.canEdit);
  const publishedLayers = layers.filter(layer => layer.kind === "personal" && !layer.canEdit);
  const overriddenLayers = sharedLayers.filter((layer) => layer.scoreSubscriptionOverride !== null);

  const save = async (changes: PreferenceChange[]) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setMessage("正在保存本谱显示设置…");
    setFailed([]);
    const results = await Promise.allSettled(changes.map(async ({ layer, subscribed }) => {
      if (!layer.sharedSlot) return;
      if (signedIn) {
        const response = await diagnosticFetch(
          `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/shared-layers/${layer.sharedSlot}/preference`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subscribed }),
          },
        );
        if (!response.ok) throw new Error("score_preference_update_failed");
      }
      await updateCachedLayer(workspace, layer.id, {
        scoreSubscriptionOverride: subscribed,
        subscribed: subscribed ?? layer.driveSubscribed ?? true,
        subscriptionSource: subscribed !== null ? "score" : layer.driveSubscribed !== null ? "drive" : "product",
      });
    }));
    if (!active.current) return;
    const failures = changes.filter((_, index) => results[index]?.status === "rejected");
    setFailed(failures);
    setMessage(failures.length
      ? `${failures.length === changes.length ? "未能保存" : `已保存 ${changes.length - failures.length} 项；未能保存`}：${failures.map(({ layer }) => sharedLayerLabel(layer.sharedSlot, layer.name)).join("、")}。未保存的显示设置保持原样，请重试。`
      : "本谱显示设置已保存");
    busy.current = false;
    setPending(false);
  };

    const changePersonal = async (path: string, body: { sharing: boolean } | { subscribed: boolean }, layer: AnnotationLayerSummary) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setFailed([]); setMessage("正在保存…");
    try {
      const response = await diagnosticFetch(`/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/${path}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("personal_layer_update_failed");
      await updateCachedLayer(workspace, layer.id, body);
      if (active.current) setMessage("设置已保存");
      await syncAnnotations(workspace, { pull: true });
    } catch {
      if (active.current) setMessage("未能完成保存或刷新，请检查网络后重试。");
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  };

  return (
    <section className="reader-layer-panel" aria-label="看哪些批注" aria-busy={pending}>
      <p className="reader-layer-help">仅用于这份乐谱。</p>
      <div className="layer-section">
        <div className="layer-section__heading">
          <div><h3>共享层</h3></div>
          <div className="layer-section__actions">
            <span>{sharedLayers.filter((layer) => layer.subscribed).length} / {sharedLayers.length}</span>
            {overriddenLayers.length > 0 ? (
              <Button className="layer-section__restore" isDisabled={pending}
                aria-description="将这份乐谱的所有共享层恢复为我的云盘默认显示设置"
                onPress={() => void save(overriddenLayers.map((layer) => ({ layer, subscribed: null })))}>
                使用云盘默认
              </Button>
            ) : null}
          </div>
        </div>
        {message ? <div className="reader-layer-feedback" data-error={failed.length > 0 || undefined}>
          <p role={failed.length ? "alert" : "status"}>{message}</p>
          {failed.length > 0 ? <Button isDisabled={pending} onPress={() => void save(failed)}>重试未保存项</Button> : null}
        </div> : null}
        <div className="layer-card-list">
          {sharedLayers.map((layer) => (
            <article className="layer-card" key={layer.id}>
              <div className="layer-card__main reader-layer-row">
                <label className="reader-layer-toggle">
                  <input aria-label={`显示 ${sharedLayerLabel(layer.sharedSlot, layer.name)}`}
                    checked={layer.subscribed} disabled={pending} type="checkbox"
                    onChange={(event) => void save([{ layer, subscribed: event.target.checked }])} />
                  <span aria-label={`${sharedLayerLabel(layer.sharedSlot, layer.name)} 当前颜色`} className="layer-color-preview" style={{ background: layer.displayColor }} />
                  <span className="layer-card__identity"><strong>
                    <span className="layer-card__slot">{sharedLayerPrefix(layer.sharedSlot) ? layer.sharedSlot : ""}</span>
                    {sharedLayerPrefix(layer.sharedSlot) ? <span aria-hidden="true" className="layer-card__separator">·</span> : null}{sharedLayerDisplayName(layer.sharedSlot, layer.name)}
                  </strong></span>
                  {layer.scoreSubscriptionOverride !== null ? <span className="layer-card__score-override">本谱</span> : null}
                </label>
              </div>
            </article>
          ))}
        </div>
      </div>
      {personalLayer ? <div className="layer-section layer-section--personal">
        <article className="layer-card"><div className="layer-card__main">
          <span className="layer-color-preview" style={{ background: personalLayer.displayColor }} />
          <div className="layer-card__identity"><strong><span className="layer-card__slot">P</span>
            <span aria-hidden="true" className="layer-card__separator">·</span>我的笔记</strong></div>
          <span className="reader-layer-help">始终显示<br />{personalLayer.sharing ? "云盘成员可见" : "仅自己可见"}</span>
        </div>
        {personalLayer.canShare ? <div className="reader-sharing-control">
          <p>分享后，这份谱的现有个人笔记及后续修改对云盘成员可见，只有你能编辑。其他乐谱仍保持原来的分享设置。</p>
          <label><input type="checkbox" checked={personalLayer.sharing ?? false} disabled={pending}
            onChange={event => void changePersonal("personal-layer/sharing", { sharing: event.target.checked }, personalLayer)} />向云盘成员分享这份谱的个人层</label>
          {personalLayer.sharing ? <p>取消分享会停止在线访问；已下载的离线笔记在对方设备重新联网后移除。</p> : null}
        </div> : null}
        </article>
      </div> : null}
      {publishedLayers.length ? <div className="layer-section"><h3>成员分享</h3>
        <p className="reader-layer-help">订阅后显示作者的最新笔记，仅供阅读。</p>
        {publishedLayers.map(layer => <label className="reader-layer-toggle" key={layer.id}>
          <input type="checkbox" aria-label={`订阅 ${layer.name}`} checked={layer.subscribed} disabled={pending}
            onChange={event => void changePersonal(`personal-layers/${layer.id}/subscription`, { subscribed: event.target.checked }, layer)} />
          <span className="layer-color-preview" style={{ background: layer.displayColor }} />{layer.name}
        </label>)}
      </div> : null}
    </section>
  );
}
