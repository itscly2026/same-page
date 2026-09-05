import { diagnosticFetch } from "../diagnostics/diagnostics";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  defaultSharedLayerSlotSchema,
  sharedLayerGrantListResponseSchema,
  sharedLayerManagementResponseSchema,
  type SharedLayerGrantMember,
  type SharedLayerManagementSummary,
} from "../../shared/annotations";
import { AppHeader } from "../components/app-header";
import { authClient } from "../auth/auth-client";
import { SettingsFeedback } from "../settings/settings-feedback";
import { settingsError, settingsResponse } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";

export default function SharedLayerGrantsPage() {
  const { choirId = "", slot: slotParam = "" } = useParams();
  const session = authClient.useSession();
  return <SharedLayerGrants key={`${session.data?.user.id ?? "guest"}:${choirId}:${slotParam}`} choirId={choirId} slotParam={slotParam} />;
}

function SharedLayerGrants({ choirId, slotParam }: { choirId: string; slotParam: string }) {
  const parsedSlot = defaultSharedLayerSlotSchema.safeParse(slotParam);
  const slot = parsedSlot.success ? parsedSlot.data : null;
  const [driveName, setDriveName] = useState("");
  const [layer, setLayer] = useState<SharedLayerManagementSummary | null>(null);
  const [members, setMembers] = useState<SharedLayerGrantMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const generation = useSettingsLifetime();
  const retryLoad = () => {
    setLoadError(null);
    setLoading(true);
    setLoadAttempt((attempt) => attempt + 1);
  };
  const [results, setResults] = useState<Record<string, { message: string; failedGrant?: boolean }>>({});
  const pendingMembersRef = useRef(new Set<string>());
  const [pendingMembers, setPendingMembers] = useState(new Set<string>());

  useEffect(() => {
    if (!slot) return;
    let active = true;
    void Promise.all([
      diagnosticFetch(`/api/choirs/${choirId}/shared-layers`).then(async (response) => {
        return sharedLayerManagementResponseSchema.parse(await settingsResponse(response));
      }),
      diagnosticFetch(`/api/choirs/${choirId}/shared-layers/${slot}/grants`).then(async (response) => {
        return sharedLayerGrantListResponseSchema.parse(await settingsResponse(response));
      }),
    ]).then(([management, grants]) => {
      if (!active) return;
      setDriveName(management.drive.name);
      setLayer(management.layers.find((entry) => entry.slot === slot) ?? null);
      setMembers(grants.members);
      setLoading(false);
    }).catch((error: unknown) => {
      if (active) { setLoadError(settingsError(error, "暂时无法读取编辑权限。")); setLoading(false); }
    });
    return () => {
      active = false;
    };
  }, [choirId, slot, loadAttempt]);

  const updateGrant = async (member: SharedLayerGrantMember, granted: boolean) => {
    if (!slot || member.role === "admin" || pendingMembersRef.current.has(member.id)) return;
    const requestGeneration = generation.current;
    pendingMembersRef.current.add(member.id);
    setPendingMembers(new Set(pendingMembersRef.current));
    setResults((current) => ({ ...current, [member.id]: { message: "正在保存…" } }));
    try {
      const response = await diagnosticFetch(
        `/api/choirs/${choirId}/shared-layers/${slot}/grants/${member.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ granted }),
        },
      );
      await settingsResponse(response);
      if (requestGeneration !== generation.current) return;
      setMembers((current) => current.map((entry) =>
        entry.id === member.id ? { ...entry, granted } : entry));
      setResults((current) => ({ ...current, [member.id]: { message: "编辑权限已更新。" } }));
    } catch (error: unknown) {
      if (requestGeneration !== generation.current) return;
      setResults((current) => ({ ...current, [member.id]: {
        message: settingsError(error, "权限更新失败，原设置已保留。"), failedGrant: granted,
      } }));
    } finally {
      if (requestGeneration === generation.current) {
        pendingMembersRef.current.delete(member.id);
        setPendingMembers(new Set(pendingMembersRef.current));
      }
    }
  };

  const layerName = layer ? `${layer.slot} · ${layer.name}` : slot ?? "共享层";


  return (
    <div className="app-page">
      <AppHeader actions={(
        <Link className="header-action" to={`/choirs/${choirId}/shared-layers`}>
          返回共享层管理
        </Link>
      )} />
      <main className="page-shell settings-page settings-ux">
        <header className="settings-heading">
          <p className="eyebrow">云盘管理 · {driveName || "共享层"}</p>
          <h1>{layerName} 编辑权限</h1>
          <p className="settings-copy">管理员始终可以编辑；以下授权对当前云盘中的全部乐谱生效。</p>
        </header>
        {slot ? <SettingsFeedback loading={loading} loadError={loadError} message={null} retry={retryLoad} /> : <p role="alert">共享层不存在。</p>}
        <section className="settings-card" aria-label={`${layerName} 编辑成员`} aria-busy={loading}>
          {members.map((member) => (
            <article className="settings-member-item" key={member.id}>
            <label className="settings-member-row">
              <span>
                <strong>{member.displayName}</strong>
                {member.role === "admin" ? <small>管理员 · 始终可编辑</small> : <small>{member.granted ? "可以编辑" : "未授权编辑"}</small>}
              </span>
              <input
                aria-label={`${member.displayName}${member.role === "admin" ? " 管理员" : ""}`}
                checked={member.role === "admin" || member.granted}
                disabled={member.role === "admin" || pendingMembers.has(member.id)}
                type="checkbox"
                onChange={(event) => void updateGrant(member, event.target.checked)}
              />
            </label>
            {results[member.id] ? <div className="settings-row-feedback">
              <span role={results[member.id].failedGrant !== undefined ? "alert" : "status"}>{results[member.id].message}</span>
              {results[member.id].failedGrant !== undefined ? <button type="button" className="text-button"
                disabled={pendingMembers.has(member.id)} aria-label={`重试 ${member.displayName}`}
                onClick={() => void updateGrant(member, results[member.id].failedGrant!)}>重试</button> : null}
            </div> : null}
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
