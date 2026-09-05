import { useEffect, useRef, useState } from "react";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
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
  const personalLayer = layers.find((layer) => layer.kind === "personal");
  const overriddenLayers = sharedLayers.filter((layer) => layer.scoreSubscriptionOverride !== null);

  const save = async (changes: PreferenceChange[]) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setMessage("正在保存本谱显示设置…");
    setFailed([]);
    const results = await Promise.allSettled(changes.map(async ({ layer, subscribed }) => {
      if (!layer.defaultSlot) return;
      if (signedIn) {
        const response = await diagnosticFetch(
          `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/shared-layers/${layer.defaultSlot}/preference`,
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
      ? `${failures.length === changes.length ? "未能保存" : `已保存 ${changes.length - failures.length} 项；未能保存`}：${failures.map(({ layer }) => `${layer.defaultSlot} · ${layer.name}`).join("、")}。未保存的显示设置保持原样，请重试。`
      : "本谱显示设置已保存");
    busy.current = false;
    setPending(false);
  };

  return (
    <section className="reader-layer-panel" aria-label="图层" aria-busy={pending}>
      <p className="reader-layer-help">只调整这份乐谱的阅读显示，不影响编辑权限。</p>
      <div className="layer-section">
        <div className="layer-section__heading">
          <div><h3>共享层</h3></div>
          <div className="layer-section__actions">
            <span>{sharedLayers.filter((layer) => layer.subscribed).length} / 5</span>
            {overriddenLayers.length > 0 ? (
              <Button className="layer-section__restore" isDisabled={pending}
                aria-description="将这份乐谱的所有共享层恢复为我的云盘默认显示设置"
                onPress={() => void save(overriddenLayers.map((layer) => ({ layer, subscribed: null })))}>
                恢复我的默认
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
                  <input aria-label={`订阅 ${layer.defaultSlot} · ${layer.name}`}
                    checked={layer.subscribed} disabled={pending} type="checkbox"
                    onChange={(event) => void save([{ layer, subscribed: event.target.checked }])} />
                  <span aria-label={`${layer.defaultSlot} · ${layer.name} 当前颜色`} className="layer-color-preview" style={{ background: layer.displayColor }} />
                  <span className="layer-card__identity"><strong>
                    <span className="layer-card__slot">{layer.defaultSlot}</span>
                    <span aria-hidden="true" className="layer-card__separator">·</span>{layer.name}
                  </strong></span>
                  {layer.scoreSubscriptionOverride !== null ? <span className="layer-card__score-override">本谱</span> : null}
                </label>
                {layer.scoreSubscriptionOverride !== null ? (
                  <Button aria-label={`恢复 ${layer.defaultSlot} · ${layer.name} 的云盘默认订阅`}
                    className="layer-card__restore" isDisabled={pending}
                    onPress={() => void save([{ layer, subscribed: null }])}>恢复</Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
      {personalLayer ? <div className="layer-section layer-section--personal">
        <div className="layer-section__heading"><div><h3>个人层</h3></div></div>
        <article className="layer-card"><div className="layer-card__main">
          <span className="layer-color-preview" style={{ background: personalLayer.displayColor }} />
          <div className="layer-card__identity"><strong><span className="layer-card__slot">P</span>
            <span aria-hidden="true" className="layer-card__separator">·</span>Personal</strong></div>
          <span className="reader-layer-help">仅自己可见</span>
        </div></article>
      </div> : null}
    </section>
  );
}
