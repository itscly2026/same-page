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

export default function SharedLayerGrantsPage() {
  const { choirId = "", slot: slotParam = "" } = useParams();
  const parsedSlot = defaultSharedLayerSlotSchema.safeParse(slotParam);
  const slot = parsedSlot.success ? parsedSlot.data : null;
  const [driveName, setDriveName] = useState("");
  const [layer, setLayer] = useState<SharedLayerManagementSummary | null>(null);
  const [members, setMembers] = useState<SharedLayerGrantMember[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const pendingMembersRef = useRef(new Set<string>());
  const [pendingMembers, setPendingMembers] = useState(new Set<string>());

  useEffect(() => {
    if (!slot) return;
    let active = true;
    void Promise.all([
      diagnosticFetch(`/api/choirs/${choirId}/shared-layers`).then(async (response) => {
        if (!response.ok) throw new Error("shared_layers_unavailable");
        return sharedLayerManagementResponseSchema.parse(await response.json());
      }),
      diagnosticFetch(`/api/choirs/${choirId}/shared-layers/${slot}/grants`).then(async (response) => {
        if (!response.ok) throw new Error("layer_grants_unavailable");
        return sharedLayerGrantListResponseSchema.parse(await response.json());
      }),
    ]).then(([management, grants]) => {
      if (!active) return;
      setDriveName(management.drive.name);
      setLayer(management.layers.find((entry) => entry.slot === slot) ?? null);
      setMembers(grants.members);
    }).catch(() => {
      if (active) setMessage("暂时无法读取编辑权限，请稍后重试。");
    });
    return () => {
      active = false;
    };
  }, [choirId, slot]);

  const updateGrant = async (member: SharedLayerGrantMember, granted: boolean) => {
    if (!slot || member.role === "admin" || pendingMembersRef.current.has(member.id)) return;
    pendingMembersRef.current.add(member.id);
    setPendingMembers(new Set(pendingMembersRef.current));
    const previousMember = member;
    setMessage(null);
    setMembers((current) => current.map((entry) =>
      entry.id === member.id ? { ...entry, granted } : entry));
    try {
      const response = await diagnosticFetch(
        `/api/choirs/${choirId}/shared-layers/${slot}/grants/${member.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ granted }),
        },
      );
      if (!response.ok) throw new Error("grant_update_failed");
      setMessage("编辑权限已更新。");
    } catch {
      setMembers((current) => current.map((entry) =>
        entry.id === previousMember.id ? previousMember : entry));
      setMessage("权限更新失败，原设置已保留。");
    } finally {
      pendingMembersRef.current.delete(member.id);
      setPendingMembers(new Set(pendingMembersRef.current));
    }
  };

  const layerName = layer ? `${layer.slot} · ${layer.name}` : slot ?? "共享层";
  const visibleMessage = slot ? message : "共享层不存在。";

  return (
    <div className="app-page">
      <AppHeader actions={(
        <Link className="header-action" to={`/choirs/${choirId}/shared-layers`}>
          返回共享层管理
        </Link>
      )} />
      <main className="page-shell settings-page">
        <header className="settings-heading">
          <p className="eyebrow">云盘管理 · {driveName || "共享层"}</p>
          <h1>{layerName} 编辑权限</h1>
          <p className="settings-copy">管理员始终可以编辑；以下授权对当前云盘中的全部乐谱生效。</p>
        </header>
        {visibleMessage ? <p className="library-message" role="status">{visibleMessage}</p> : null}
        <section className="settings-card" aria-label={`${layerName} 编辑成员`}>
          {members.map((member) => (
            <label className="settings-member-row" key={member.id}>
              <span>
                <strong>{member.displayName}</strong>
                {member.role === "admin" ? <small>管理员</small> : <small>成员</small>}
              </span>
              <input
                aria-label={`${member.displayName}${member.role === "admin" ? " 管理员" : ""}`}
                checked={member.granted}
                disabled={member.role === "admin" || pendingMembers.has(member.id)}
                type="checkbox"
                onChange={(event) => void updateGrant(member, event.target.checked)}
              />
            </label>
          ))}
        </section>
      </main>
    </div>
  );
}
