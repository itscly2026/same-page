import { Button } from "react-aria-components";

import type { AnnotationLayerSummary } from "../../shared/annotations";
import { updateCachedLayer } from "../annotations/local-annotations";
import type { LocalWorkspace } from "../platform/local-workspace";

export function ReaderLayerPanel({
  workspace,
  layers,
  signedIn,
}: {
  workspace: LocalWorkspace;
  layers: AnnotationLayerSummary[];
  signedIn: boolean;
}) {
  const sharedLayers = layers.filter((layer) => layer.kind === "shared");
  const personalLayer = layers.find((layer) => layer.kind === "personal");
  const overriddenLayers = sharedLayers.filter(
    (layer) => layer.scoreSubscriptionOverride !== null,
  );

  const saveScorePreference = async (
    layer: AnnotationLayerSummary,
    changes: { subscribed: boolean | null },
  ) => {
    if (!layer.defaultSlot) return;
    if (signedIn) {
      const response = await fetch(
        `/api/choirs/${workspace.choirId}/scores/${workspace.scoreId}/shared-layers/${layer.defaultSlot}/preference`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(changes),
        },
      );
      if (!response.ok) throw new Error("score_preference_update_failed");
    }
    const scoreSubscriptionOverride = changes.subscribed;
    await updateCachedLayer(workspace, layer.id, {
      scoreSubscriptionOverride,
      subscribed: scoreSubscriptionOverride ?? layer.driveSubscribed ?? true,
      subscriptionSource: scoreSubscriptionOverride !== null
        ? "score"
        : layer.driveSubscribed !== null
          ? "drive"
          : "product",
    });
  };

  return (
    <section className="reader-layer-panel" aria-label="图层">
      <div className="layer-section">
        <div className="layer-section__heading">
          <div><h3>共享层</h3></div>
          <div className="layer-section__actions">
            <span>{sharedLayers.filter((layer) => layer.subscribed).length} / 5</span>
            {overriddenLayers.length > 0 ? (
              <Button
                className="layer-section__restore"
                onPress={() => void Promise.all(overriddenLayers.map((layer) =>
                  saveScorePreference(layer, { subscribed: null })))}
              >
                恢复我的默认
              </Button>
            ) : null}
          </div>
        </div>
        <div className="layer-card-list">
          {sharedLayers.map((layer) => (
            <article className="layer-card" key={layer.id}>
              <div className="layer-card__main">
                <input
                  aria-label={`订阅 ${layer.defaultSlot} · ${layer.name}`}
                  checked={layer.subscribed}
                  type="checkbox"
                  onChange={(event) => void saveScorePreference(layer, {
                    subscribed: event.target.checked,
                  })}
                />
                <span
                  aria-label={`${layer.defaultSlot} · ${layer.name} 当前颜色`}
                  className="layer-color-preview"
                  style={{ background: layer.displayColor }}
                />
                <div className="layer-card__identity">
                  <strong>
                    <span className="layer-card__slot">{layer.defaultSlot}</span>
                    <span aria-hidden="true" className="layer-card__separator">·</span>
                    {layer.name}
                  </strong>
                </div>
                {layer.scoreSubscriptionOverride !== null ? (
                  <span className="layer-card__score-override">本谱</span>
                ) : null}
                {layer.scoreSubscriptionOverride !== null ? (
                  <Button
                    aria-label={`恢复 ${layer.defaultSlot} · ${layer.name} 的云盘默认订阅`}
                    className="layer-card__restore"
                    onPress={() => void saveScorePreference(layer, { subscribed: null })}
                  >
                    恢复
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
      {personalLayer ? (
        <div className="layer-section layer-section--personal">
          <div className="layer-section__heading"><div><h3>个人层</h3></div></div>
          <article className="layer-card">
            <div className="layer-card__main">
              <span
                className="layer-color-preview"
                style={{ background: personalLayer.displayColor }}
              />
              <div className="layer-card__identity">
                <strong>
                  <span className="layer-card__slot">P</span>
                  <span aria-hidden="true" className="layer-card__separator">·</span>
                  Personal
                </strong>
              </div>
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
