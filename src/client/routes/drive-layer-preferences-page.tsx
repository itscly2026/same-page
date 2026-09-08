import { loginHref } from "../auth/login-return";
import { runSettingsMutation, settingsMutationMessage } from "../settings/settings-mutation";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  driveLayerPreferencesResponseSchema,
  type DriveLayerPreferenceSummary,
} from "../../shared/annotations";
import { TaskHeader } from "../components/task-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { SettingsRequestError, settingsError, settingsResponse } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function DriveLayerPreferencesPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  if (!session.data && !session.isPending) return <div className="app-page"><TaskHeader title="阅读偏好" backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page"><p>登录后设置你在此云盘的默认显示。访客仍可继续只读浏览。</p><Link to={loginHref(`/choirs/${choirId}/preferences`)}>登录后设置默认显示</Link></main></div>;
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
  const [loadStatus, setLoadStatus] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generation = useSettingsLifetime();
  const retryLoad = () => {
    setLoadError(null); setLoadStatus(null);
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
        if (active) { setLoadStatus(error instanceof SettingsRequestError ? error.status : null); setLoadError(error instanceof SettingsRequestError && error.status === 403 ? "当前身份无法设置此云盘的个人默认，请返回云盘确认访问方式。" : settingsError(error, "暂时无法读取图层偏好。")); setLoading(false); }
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
      <TaskHeader title={colors ? "笔记颜色" : "阅读偏好"} backTo={colors ? `/choirs/${choirId}/preferences` : `/choirs/${choirId}`} />
      <main className="page-shell settings-page settings-ux reading-preferences">
        <header className="settings-heading">

          {driveName ? <p>{driveName}</p> : null}
          <p className="settings-copy">{colors
            ? "应用于此云盘的乐谱，仅影响你。单独调整过颜色的乐谱保持原设置。"
            : "应用于此云盘的乐谱，仅影响你。单独调整过的乐谱保持原设置。"}</p>
        </header>
        <p className="settings-copy">更改自动保存</p>
        {loadStatus === 401 || loadStatus === 403 ? <div><p role="alert">{loadError}</p>{loadStatus === 401 && <Link to={loginHref(`/choirs/${choirId}/preferences`)}>重新登录</Link>}</div> : <SettingsFeedback loading={loading} loadError={loadError} message={null} retry={retryLoad} />}
        {!loadError && !loading && <section className="settings-card" aria-label={colors ? "笔记颜色" : "默认显示的笔记"} aria-busy={loading}>
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
        </section>}
        {!colors && !loading && !loadError ? <Link className="settings-secondary-link" to="?view=colors">
          <span>笔记颜色</span><span aria-hidden="true">›</span>
        </Link> : null}
      </main>
    </div>
  );
}
