import { runSettingsMutation, settingsMutationMessage } from "../settings/settings-mutation";
import { BackButton } from "../navigation/back-button";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  driveLayerPreferencesResponseSchema,
  type DriveLayerPreferenceSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function DriveLayerPreferencesPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <DriveLayerPreferences key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}

type PreferenceChange = { subscribed?: boolean; colorOverride?: string | null };
type SaveResult = { message: string; failed?: PreferenceChange };

function DriveLayerPreferences({ choirId }: { choirId: string }) {
  const [searchParams] = useSearchParams();
  const colors = searchParams.get("view") === "colors";
  const [driveName, setDriveName] = useState("");
  const [layers, setLayers] = useState<DriveLayerPreferenceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generation = useSettingsLifetime();
  const retryLoad = () => {
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };
  const [results, setResults] = useState<Record<string, SaveResult>>({});
  const pendingSlotsRef = useRef(new Set<string>());
  const [pendingSlots, setPendingSlots] = useState(new Set<string>());

  useEffect(() => {
    let active = true;
    void diagnosticFetch(`/api/choirs/${choirId}/shared-layer-preferences`)
      .then(async (response) => {
        return driveLayerPreferencesResponseSchema.parse(await settingsResponse(response));
      })
      .then((body) => {
        if (!active) return;
        setDriveName(body.drive.name);
        setLayers(body.layers);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (active) { setLoadError(settingsError(error, "暂时无法读取图层偏好。")); setLoading(false); }
      });
    return () => {
      active = false;
    };
  }, [choirId, loadAttempt]);

  const updatePreference = async (
    layer: DriveLayerPreferenceSummary,
    changes: PreferenceChange,
  ) => {
    if (pendingSlotsRef.current.has(layer.slot)) return;
    const requestGeneration = generation.current;
    pendingSlotsRef.current.add(layer.slot);
    setPendingSlots(new Set(pendingSlotsRef.current));
    const resultKey = `${layer.slot}:${changes.subscribed === undefined ? "colors" : "display"}`;
    setResults((current) => ({ ...current, [resultKey]: { message: "正在保存…" } }));
    const result = await runSettingsMutation(() => diagnosticFetch(
      `/api/choirs/${choirId}/shared-layers/${layer.slot}/preference`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(changes) },
    ));
    if (requestGeneration !== generation.current) return;
    if (result.kind === "saved") {
      setLayers((current) => current.map((entry) => {
        if (entry.slot !== layer.slot) return entry;
        const colorOverride = changes.colorOverride === undefined ? entry.colorOverride : changes.colorOverride;
        return { ...entry, subscribed: changes.subscribed ?? entry.subscribed, colorOverride,
          displayColor: colorOverride ?? entry.adminDefaultColor,
          colorSource: colorOverride ? "drive" : "admin" };
      }));
    }
    if (result.kind === "revoked") setLoadError(settingsMutationMessage(result));
    setResults(current => ({ ...current, [resultKey]: {
      message: settingsMutationMessage(result, "已保存"),
      // PUT is idempotent: explicitly retrying the same intent is safe even
      // when its first response was lost.
      ...(result.kind === "failed" || result.kind === "unconfirmed" ? { failed: changes } : {}),
    } }));
    pendingSlotsRef.current.delete(layer.slot);
    setPendingSlots(new Set(pendingSlotsRef.current));
  };

  return (
    <div className="app-page">
      <AppHeader actions={<BackButton className="header-action" to={colors ? `/choirs/${choirId}/preferences` : `/choirs/${choirId}`}>
        返回
      </BackButton>} />
      <main className="page-shell settings-page settings-ux reading-preferences">
        <header className="settings-heading">
          <h1>{colors ? "笔记颜色" : "阅读偏好"}</h1>
          {driveName ? <p>{driveName}</p> : null}
          <p className="settings-copy">{colors
            ? "仅改变你在此云盘看到的共享笔记颜色。"
            : "适用于此云盘。单独设置过的乐谱保留自己的显示选择。"}</p>
        </header>
        <SettingsFeedback loading={loading} loadError={loadError} message={null} retry={retryLoad} />
        <section className="settings-card" aria-label={colors ? "笔记颜色" : "默认显示的笔记"} aria-busy={loading}>
          {!colors ? <h2 className="settings-group-title">默认显示的笔记</h2> : null}
          {layers.map((layer) => {
            const name = layer.name;
            const result = results[`${layer.slot}:${colors ? "colors" : "display"}`];
            return <article className="preference-row" key={layer.slot}>
              {colors ? <>
                <div className="preference-color-heading">
                  <strong>{name}</strong>
                  <label className="settings-color-control">
                    <span>{layer.colorOverride ? "自定义" : "云盘默认"}</span>
                    <input aria-label={`${name} 笔记颜色`} type="color" value={layer.displayColor}
                      disabled={Boolean(loadError) || loading || pendingSlots.has(layer.slot)}
                      onChange={(event) => void updatePreference(layer, { colorOverride: event.target.value })} />
                  </label>
                </div>
                <div className="preference-color-preview" style={{ color: layer.displayColor }} aria-label={`${name} 笔记预览`}>
                  <svg aria-hidden="true" viewBox="0 0 120 24"><path d="M4 16 Q30 2 58 14 T116 8" /></svg>
                  <span>渐弱 · 留意呼吸</span>
                </div>
                {layer.colorOverride ? <button className="text-button" type="button"
                  disabled={Boolean(loadError) || loading || pendingSlots.has(layer.slot)} aria-label={`${name} 恢复默认颜色`}
                  onClick={() => void updatePreference(layer, { colorOverride: null })}>恢复默认颜色</button> : null}
              </> : <label className="preference-display-toggle">
                <span className="settings-layer-swatch" aria-hidden="true" style={{ background: layer.displayColor }} />
                <strong>{name}</strong>
                <input aria-label={`${name} 默认显示`} type="checkbox" checked={layer.subscribed}
                  disabled={Boolean(loadError) || loading || pendingSlots.has(layer.slot)}
                  onChange={(event) => void updatePreference(layer, { subscribed: event.target.checked })} />
              </label>}
              {result ? <div className="settings-row-feedback">
                <span role={result.failed ? "alert" : "status"}>{result.message}</span>
                {result.failed ? <button className="text-button" type="button" disabled={Boolean(loadError) || loading || pendingSlots.has(layer.slot)}
                  aria-label={`重试 ${name}`} onClick={() => void updatePreference(layer, result.failed!)}>重试</button> : null}
              </div> : null}
            </article>;
          })}
        </section>
        {!colors && !loading && !loadError ? <Link className="settings-secondary-link" to="?view=colors">
          <span>笔记颜色</span><span aria-hidden="true">›</span>
        </Link> : null}
      </main>
    </div>
  );
}
