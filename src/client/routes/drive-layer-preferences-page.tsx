import { useParams, useSearchParams, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useApplicationIdentity } from "../auth/application-identity";
import { loginHref } from "../auth/login-return";
import { TaskHeader } from "../components/task-header";
import { settingsError } from "../settings/settings-request";
import { SettingsFeedback } from "../settings/settings-feedback";
import { authenticatedLocalOwnerKey, captureLocalWorkspaceSession, createLocalWorkspace, type LocalWorkspace } from "../platform/local-workspace";
import { useDriveReadingPreferences } from "../reader/use-reading-preferences";

export default function DriveLayerPreferencesPage() {
  const { choirId = "" } = useParams();
  const identity = useApplicationIdentity();
  return <DrivePreferenceEntry key={`${identity.localUserId}:${choirId}`} choirId={choirId} userId={identity.localUserId} signedIn={!!identity.authenticatedUserId} />;
}
function DrivePreferenceEntry({ choirId, userId, signedIn }: { choirId: string; userId: string | null; signedIn: boolean }) {
  const [workspace, setWorkspace] = useState<LocalWorkspace | null>(null);
  useEffect(() => {
    let active = true;
    if (userId) void captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(userId), choirId, ""))
      .then(value => { if (active) setWorkspace(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [choirId, userId]);
  if (workspace) return <DriveLayerPreferences workspace={workspace} signedIn={signedIn} />;
  return <div className="app-page"><TaskHeader title="阅读偏好" backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page"><p>{userId ? "正在恢复阅读偏好…" : "登录后设置你在此云盘的默认显示。"}</p>{!userId && <Link to={loginHref(`/choirs/${choirId}/preferences`)}>登录后设置默认显示</Link>}</main></div>;
}
function DriveLayerPreferences({ workspace, signedIn }: { workspace: LocalWorkspace; signedIn: boolean }) {
  const { choirId } = workspace;
  const [params] = useSearchParams();
  const colors = params.get("view") === "colors";
  const resource = useDriveReadingPreferences(workspace, signedIn);
  const { layers, save, feedback: preferenceFeedback } = resource;
  return <div className="app-page"><TaskHeader title={colors ? "笔记颜色" : "阅读偏好"} backTo={colors ? `/choirs/${choirId}/preferences` : `/choirs/${choirId}`} />
    <main className="page-shell settings-page settings-ux reading-preferences">
      <header className="settings-heading"><p>{resource.drive?.name}</p><p className="settings-copy">应用于此云盘的乐谱，仅影响你。单独调整过的乐谱保持原设置。</p></header>
      <p className="settings-copy">更改自动保存</p>
      <SettingsFeedback loading={resource.loading} loadError={resource.error ? settingsError(resource.error, "暂时无法更新，已有内容已保留。") : null} message={null} retry={() => void resource.refresh().catch(() => undefined)} />
      {resource.authority === "signed-out" && <Link to={loginHref(`/choirs/${choirId}/preferences`)}>重新登录</Link>}
      {resource.drive && <section className="settings-card" aria-label={colors ? "笔记颜色" : "默认显示的笔记"}>
        {!colors && <h2 className="settings-group-title">默认显示的笔记</h2>}
        {layers.map(layer => {
          const target = { kind: "drive" as const, id: layer.slot };
          const feedback = preferenceFeedback(target);
          return <article className="preference-row" key={layer.slot}>
            {colors ? <><div className="preference-color-heading"><strong>{layer.name}</strong><label className="settings-color-control"><span>{layer.colorOverride ? "自定义" : "云盘默认"}</span>
              <input aria-label={`${layer.name} 笔记颜色`} type="color" value={layer.displayColor} onChange={event => void save(target, { colorOverride: event.target.value })} /></label></div>
              <div className="preference-color-preview" style={{ color: layer.displayColor }} aria-label={`${layer.name} 笔记预览`}><svg aria-hidden="true" viewBox="0 0 120 24"><path d="M4 16 Q30 2 58 14 T116 8" /></svg><span>渐弱 · 留意呼吸</span></div>
              {layer.colorOverride && <button className="text-button" aria-label={`${layer.name} 恢复默认颜色`} onClick={() => void save(target, { colorOverride: null })}>恢复默认颜色</button>}</>
              : <label className="preference-display-toggle"><span className="settings-layer-swatch" aria-hidden="true" style={{ background: layer.displayColor }} /><strong>{layer.name}</strong>
                <input aria-label={`${layer.name} 默认显示`} type="checkbox" checked={layer.subscribed} onChange={event => void save(target, { subscribed: event.target.checked })} /></label>}
            {feedback && <div className="settings-row-feedback"><span role="status">{feedback.message}</span>{feedback.retry && <button className="text-button" aria-label={`重试 ${layer.name}`} onClick={feedback.retry}>重试</button>}</div>}
          </article>;
        })}
      </section>}
      {!colors && resource.drive && <Link className="settings-secondary-link" to="?view=colors"><span>笔记颜色</span><span aria-hidden="true">›</span></Link>}
    </main>
  </div>;
}
