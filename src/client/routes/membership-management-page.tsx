import { SettingsFeedback } from "../settings/settings-feedback";
import { runSettingsMutation, settingsMutationMessage } from "../settings/settings-mutation";
import { SettingsRequestError, settingsError } from "../settings/settings-request";
import { useSettingsLifetime } from "../settings/use-settings-lifetime";
import { PermissionMatrix } from "../settings/permission-matrix";
import { ConfirmDialog, type Confirmation } from "../settings/confirm-dialog";
import { authClient } from "../auth/auth-client";
import { BackButton } from "../navigation/back-button";
import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useParams } from "react-router-dom";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { allPermissions, isDelegated, operationLabels, operationKeys, includesLayer, type PermissionSet } from "../../shared/drive-permissions";
import { AppHeader } from "../components/app-header";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";

type State = ReturnType<typeof managedMembershipsSchema.parse>;
type Member = State["memberships"][number];
type Layer = { slot: string; name: string };
export default function MembershipManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <MembershipManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}
function MembershipManagement({ choirId }: { choirId: string }) {
  const lifetime = useSettingsLifetime();
  const [view, setView] = useState<"member" | "permission">("member");
  const [permission, setPermission] = useState("uploadFiles");
  const [holdersOnly, setHoldersOnly] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { operations: PermissionSet; management: PermissionSet }>>({});
  const [state, setState] = useState<State | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const load = useCallback(async () => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/memberships`);
    if (!response.ok) throw new SettingsRequestError(response.status);
    const next = await parseDiagnosticResponse(response, managedMembershipsSchema);
    const definitions = await diagnosticFetch(`/api/choirs/${choirId}/permission-layers`);
    if (!definitions.ok) throw new SettingsRequestError(definitions.status);
    return { next, layers: (await definitions.json()).layers as Layer[] };
  }, [choirId]);
  useEffect(() => {
    let active = true;
    void load().then(({ next, layers }) => { if (active) { setState(next); setLayers(layers); setLoading(false); } })
      .catch(error => { if (active) { setLoading(false); setNeedsRefresh(true); setMessage(settingsError(error, "成员列表加载失败，请重试。")); } });
    return () => { active = false; };
  }, [load]);
  const reload = async () => {
    const generation = lifetime.current;
    setLoading(true);
    try {
      const next = await load();
      if (generation !== lifetime.current) return;
      setState(next.next); setLayers(next.layers); setNeedsRefresh(false); setMessage(null);
    } catch (error) {
      if (generation === lifetime.current) {
        setNeedsRefresh(true);
        if (error instanceof SettingsRequestError && [401, 403].includes(error.status)) setState(null);
      }
      throw error;
    } finally { if (generation === lifetime.current) setLoading(false); }
  };
  const mutate = async (path: string, body: unknown, method = "POST", draftId?: string) => {
    if (busy || loading || needsRefresh) return;
    const generation = lifetime.current;
    setBusy(true); setMessage(null);
    const result = await runSettingsMutation(
      () => diagnosticFetch(`/api/choirs/${choirId}/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      async () => { if (generation === lifetime.current) await reload(); },
    );
    if (generation !== lifetime.current) return;
    setMessage(settingsMutationMessage(result));
    if (draftId && (result.kind === "saved" || result.kind === "saved-refresh-failed")) setDrafts(current => {
      const next = { ...current }; delete next[draftId]; return next;
    });
    if (result.kind === "revoked") setState(null);
    if (["unconfirmed", "revoked", "saved-refresh-failed"].includes(result.kind) || (result.kind === "failed" && result.error instanceof SettingsRequestError && result.error.status === 409)) setNeedsRefresh(true);
    setBusy(false);
  };
  return <div className="app-page"><AppHeader actions={<BackButton className="header-action" to={`/choirs/${choirId}`}>返回云盘</BackButton>} /><main className="page-shell settings-page settings-ux lifecycle-page">
    <header className="settings-heading"><h1>成员与权限</h1><p>查看成员可以做什么，以及可以向他人授予哪些权限。修改仅在你的授权管理范围内生效。</p></header>
    {state && <>
      <div className="settings-actions" aria-label="权限查看方式"><Button className="secondary-button" aria-pressed={view === "member"} onPress={() => setView("member")}>按成员</Button><Button className="secondary-button" aria-pressed={view === "permission"} onPress={() => setView("permission")}>按权限</Button></div>
      {view === "permission" && <div className="permission-filter"><label>选择权限<select value={permission} onChange={event => setPermission(event.target.value)}>{operationKeys.map(key => <option key={key} value={key}>{operationLabels[key]}</option>)}<option value="all-layers">编辑全部共享层（包括未来新增层）</option>{layers.map(layer => <option key={layer.slot} value={`layer:${layer.slot}`}>编辑 {layer.name}</option>)}</select></label><label><input type="checkbox" checked={holdersOnly} onChange={event => setHoldersOnly(event.target.checked)} />仅显示可以操作或授权的成员</label></div>}
    </>}
    {state?.memberships.filter(member => view !== "permission" || !holdersOnly || member.status === "active" && (member.isOwner || hasPermission(member.operations, permission) || hasPermission(member.management, permission))).map(member => <MemberEditor focus={view === "permission" ? permission : undefined} key={`${member.id}:${member.revision}:${state.capabilities.isOwner}`} member={member} state={state} layers={layers} busy={busy || loading || needsRefresh} draft={drafts[member.id]} onDraft={draft => setDrafts(current => ({ ...current, [member.id]: draft }))}
      save={(operations, management) => void mutate(`memberships/${member.id}/permissions`, { expectedRevision: member.revision, operations, management }, "PUT", member.id)}
      change={action => setConfirmation({ title: action === "restore" ? "恢复成员关系" : "移除成员", action: action === "restore" ? "确认恢复" : "确认移除", message: action === "restore" ? "恢复成员关系和保留期内的个人层，不恢复旧权限、管理范围或分享。" : "立即撤销成员权限；断网设备已下载的内容无法即时撤回。", onConfirm: () => mutate(`memberships/${member.id}`, { action, expectedRevision: member.revision }) })}
      transfer={() => {
        const former = state.memberships.find(row => row.id === state.actorId)!;
        setConfirmation({ title: "转让拥有权", action: "确认转让", message: `将拥有权转让给「${member.displayName}」？转让后你保留的显式操作权限：${describe(former.operations, layers)}；授权管理范围：${describe(former.management, layers)}。你将不能再转让拥有权或任命受托人。`, onConfirm: () => mutate("ownership", { membershipId: member.id, confirm: true }) });
      }} />)}
    {state?.capabilities.isOwner && <AuditLog choirId={choirId!} revision={state.memberships.map(m => m.revision).join(":")} />}
    <SettingsFeedback loading={loading} loadError={null} message={message} retry={() => void reload().catch(() => undefined)} />
    {(!state || needsRefresh) && <Button className="secondary-button" isDisabled={busy || loading} onPress={() => void reload().catch(() => { setMessage("成员列表加载失败，请重试。"); })}>重新读取成员列表</Button>}
    <ConfirmDialog confirmation={confirmation} busy={busy} onClose={() => setConfirmation(null)} />
  </main></div>;
}
function describe(set: PermissionSet, layers: Layer[]): string {
  return [...set.operations.map(key => operationLabels[key]), ...(set.sharedLayers === "all" ? ["全部共享层（包括未来新增层）"] : set.sharedLayers.map(slot => layers.find(layer => layer.slot === slot)?.name ?? slot))].join("、") || "无";
}
function MemberEditor({ focus, member, state, layers, busy, save, change, transfer, draft, onDraft }: { focus?: string; draft?: { operations: PermissionSet; management: PermissionSet }; onDraft: (draft: { operations: PermissionSet; management: PermissionSet }) => void; member: Member; state: State; layers: Layer[]; busy: boolean; save: (operations: PermissionSet, management: PermissionSet) => void; change: (action: "remove" | "restore") => void; transfer: () => void }) {
  const { operations, management } = draft ?? member;
  const owner = state.capabilities.isOwner;
  const canAuthorize = owner || (isDelegated(state.capabilities.management) && !member.isOwner && !isDelegated(member.management) && member.id !== state.actorId);
  const protectedMember = Boolean(member.isOwner) || isDelegated(member.management);
  return <details className="lifecycle-member" open={focus ? true : undefined}><summary><h2>{member.displayName}</h2></summary>
    <p>{member.status === "removed" ? "已移除" : member.isOwner ? "拥有者" : isDelegated(member.management) ? "受托权限管理者" : "普通成员"}</p>
    <p>操作权限：{describe(member.isOwner ? allPermissions() : member.operations, layers)}</p>
    <p>授权管理范围：{describe(member.isOwner ? allPermissions() : member.management, layers)}</p>
    {focus && <p>此项权限：{member.isOwner || hasPermission(member.operations, focus) ? "可以操作" : "不能操作"}；{member.isOwner || hasPermission(member.management, focus) ? "可以授权他人" : "不能授权他人"}</p>}
    {!canAuthorize && <p>🔒 {member.isOwner || isDelegated(member.management) ? "只有云盘拥有者可以调整拥有者或受托人的权限。" : member.id === state.actorId ? "不能自行授权，请联系云盘拥有者或相应受托权限管理者。" : "你没有授权管理范围，请联系云盘拥有者或相应受托权限管理者。"} 拥有者：{state.memberships.find(row => row.isOwner)?.displayName ?? "请在成员列表中查看"}。</p>}
    {member.userDeleted ? <p>用户处于删除恢复期，须本人验证并恢复。</p> : member.status === "active" ? <>
      {canAuthorize && <>
        {member.isOwner === 1 && <p>拥有者始终具备全部能力。以下是转让后保留的显式授权。</p>}
        <PermissionMatrix focus={focus} operations={operations} management={management} onOperations={operations => onDraft({ operations, management })} onManagement={management => onDraft({ operations, management })} scope={owner ? allPermissions() : state.capabilities.management} owner={owner} layers={layers} disabled={busy} />
        <Button className="primary-button" isDisabled={busy} onPress={() => save(operations, management)}>保存 {member.displayName} 的权限</Button>
      </>}
      {!member.isOwner && (owner || (!protectedMember && state.capabilities.operations.operations.includes("removeMembers"))) && <details className="member-actions"><summary>成员操作</summary>
        <div className="settings-actions"><Button className="secondary-button" isDisabled={busy} onPress={() => change("remove")}>移除 {member.displayName}</Button>
        {owner && <Button className="secondary-button" isDisabled={busy} onPress={transfer}>转让拥有权给 {member.displayName}</Button>}</div>
      </details>}
    </> : (owner || state.capabilities.operations.operations.includes("removeMembers")) && <Button className="secondary-button" isDisabled={busy || member.recoverable !== 1} onPress={() => change("restore")}>恢复 {member.displayName} 的成员关系</Button>}
  </details>;
}
function AuditLog({ choirId, revision }: { choirId: string; revision: string }) {
  const [entries, setEntries] = useState<Array<{ id: string; actorName: string; targetName: string; before: string; after: string; createdAt: number }>>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; void diagnosticFetch(`/api/choirs/${choirId}/permission-changes`).then(response => response.ok ? response.json() : Promise.reject()).then(data => { if (active) { setEntries(data.changes); setError(false); setLoading(false); } }).catch(() => { if (active) { setError(true); setLoading(false); } }); return () => { active = false; }; }, [choirId, revision, attempt]);
  return <details><summary>最近权限变更记录</summary>{loading ? <p role="status">正在读取权限记录…</p> : error ? <p role="alert">权限记录读取失败。<button onClick={() => { setLoading(true); setError(false); setAttempt(value => value + 1); }}>重新读取记录</button></p> : !entries.length ? <p>暂无权限变更记录。</p> : null}{!loading && !error && entries.map(entry => <article key={entry.id}><p>{entry.actorName} → {entry.targetName} · {new Date(entry.createdAt).toLocaleString()}</p><p>变更前：{auditDescription(entry.before)}</p><p>变更后：{auditDescription(entry.after)}</p></article>)}</details>;
}
function auditDescription(json: string): string {
  const entry = JSON.parse(json);
  return entry.ownerMembershipId ? "拥有权转让" : `操作：${describe(entry.operations, [])}；管理范围：${describe(entry.management, [])}`;
}

function hasPermission(set: PermissionSet, permission: string): boolean {
  return permission === "all-layers" ? set.sharedLayers === "all" : permission.startsWith("layer:") ? includesLayer(set, permission.slice(6)) : set.operations.some(key => key === permission);
}
