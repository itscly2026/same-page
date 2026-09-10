import { driveManagementSchema } from "../../shared/drive-management";
import { ViewSelector } from "../components/view-selector";
import { useReadResource } from "../settings/use-read-resource";
import { useUnsavedChanges } from "../settings/use-unsaved-changes";
import { SettingsFeedback } from "../settings/settings-feedback";
import { useSettingsMutation } from "../settings/settings-mutation";
import { SettingsRequestError, settingsError } from "../settings/settings-request";
import { PermissionMatrix } from "../settings/permission-matrix";
import { ConfirmDialog, type Confirmation } from "../settings/confirm-dialog";
import { authClient } from "../auth/auth-client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useParams } from "react-router-dom";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { allPermissions, isDelegated, operationLabels, operationKeys, includesLayer, type PermissionSet } from "../../shared/drive-permissions";
import { TaskHeader } from "../components/task-header";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";

type State = ReturnType<typeof managedMembershipsSchema.parse>;
type Member = State["memberships"][number];
type Layer = { slot: string; name: string };
export default function MembershipManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <MembershipManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} userId={session.data?.user.id ?? "guest"} />;
}
function MembershipManagement({ choirId, userId }: { choirId: string; userId: string }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [view, setView] = useState<"member" | "permission">("member");
  const [permission, setPermission] = useState("uploadFiles");
  const [editingMember, setEditingMember] = useState("");
  const [drafts, setDrafts] = useState<Record<string, { operations: PermissionSet; management: PermissionSet }>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    const overviewResponse = await diagnosticFetch(`/api/choirs/${choirId}/management`, { signal });
    if (!overviewResponse.ok) throw new SettingsRequestError(overviewResponse.status);
    const overview = await parseDiagnosticResponse(overviewResponse, driveManagementSchema);
    if (!overview.isMember) return { next: null, layers: [], overview };
    const response = await diagnosticFetch(`/api/choirs/${choirId}/memberships`, { signal });
    if (!response.ok) throw new SettingsRequestError(response.status);
    const next = await parseDiagnosticResponse(response, managedMembershipsSchema);
    const definitions = await diagnosticFetch(`/api/choirs/${choirId}/permission-layers`, { signal });
    if (!definitions.ok) throw new SettingsRequestError(definitions.status);
    return { next, layers: (await definitions.json()).layers as Layer[], overview };
  }, [choirId]);
  const resource = useReadResource(`${userId}:${choirId}:memberships`, load);
  const state = resource.data?.next ?? null;
  const layers = resource.data?.layers ?? [];
  const loading = resource.request === "pending";
  const mutation = useSettingsMutation({ enabled: resource.canMutate, refresh: resource.refresh, onRevoked: resource.clear });
  const { pending: busy, needsRefresh, message, refresh: reload } = mutation;
  const mutate = async (path: string, body: unknown, method = "POST", draftId?: string) =>
    await mutation.submit(
      () => diagnosticFetch(`/api/choirs/${choirId}/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      { confirmed: () => {
        if (draftId) setDrafts(current => {
          const next = { ...current }; delete next[draftId]; return next;
        });
      } },
    ) === true;
  const dirtyMembers = state?.memberships.filter(member => drafts[member.id] && !sameMemberPermissions(drafts[member.id], member)) ?? [];
  const exitDialog = useUnsavedChanges({ subject: "成员权限", dirty: dirtyMembers.length > 0, saveState: mutation,
    discard: () => setDrafts({}),
    save: async () => {
      for (const member of dirtyMembers) {
        if (!await mutate(`memberships/${member.id}/permissions`, { expectedRevision: member.revision, ...drafts[member.id] }, "PUT", member.id)) return false;
      }
      return true;
    },
  });
  return <div className="app-page"><TaskHeader title={"成员与权限"} backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page settings-ux lifecycle-page">
    {exitDialog}<header className="settings-heading"><p>找有权处理问题的人，或查看成员的权限。</p></header>
    {resource.data && !resource.data.overview.isMember && <section className="management-list">
      <h2>{resource.data.overview.name}</h2>
      <p>成员与权限用于查看云盘内的权限分工，找到有权上传乐谱、配置共享层或管理成员的人。</p>
      <p>操作权限决定成员能做什么；授权管理范围决定成员能把哪些权限授予别人。</p>
      <p className="permission-lock-explanation">成员名单与个人权限仅向云盘成员开放。你可以浏览功能说明；成为成员后可查看实际分工，调整权限还需要相应授权。</p>
    </section>}
    {state && <>
      <ViewSelector<"member" | "permission"> label="权限查看方式" value={view} onChange={setView} options={[{ id: "member", label: "按成员" }, { id: "permission", label: "按权限" }]} />
      {view === "member" && <div className="member-filters"><label>搜索成员<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="云盘内显示名" /></label><label>成员状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="active">活动成员</option><option value="removed">已移除成员</option></select></label></div>}
      {dirtyMembers.length > 0 && <p role="status">{dirtyMembers.length} 位成员的权限未保存</p>}
      {view === "permission" && <div className="permission-filter"><label>选择权限<select value={permission} onChange={event => { setPermission(event.target.value); setEditingMember(""); }}>{operationKeys.map(key => <option key={key} value={key}>{operationLabels[key]}</option>)}<option value="all-layers">编辑全部共享层（包括未来新增层）</option>{layers.map(layer => <option key={layer.slot} value={`layer:${layer.slot}`}>编辑 {layer.name}</option>)}</select></label></div>}
    </>}
    {state && view === "permission" && <>
      <PermissionPeople title="可以操作" members={state.memberships.filter(member => member.status === "active" && (member.isOwner || hasPermission(member.operations, permission)))} />
      <PermissionPeople title="可以授权" members={state.memberships.filter(member => member.status === "active" && (member.isOwner || hasPermission(member.management, permission)))} />
      {state.capabilities.isOwner || hasPermission(state.capabilities.management, permission) ? <details className="permission-edit-entry"><summary>调整此项权限</summary><label>选择成员<select value={editingMember} onChange={event => setEditingMember(event.target.value)}><option value="">选择要调整的成员</option>{state.memberships.filter(member => member.status === "active" && (state.capabilities.isOwner || !member.isOwner && !isDelegated(member.management) && member.id !== state.actorId)).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label><p className="settings-copy">受托人只能调整普通成员，不能为自己或其他受托人授权。</p></details> : <p className="settings-copy permission-note">这项权限不在你的授权管理范围内。需要调整时，请联系上方可以授权的成员。</p>}
    </>}
    {state?.memberships.filter(member => view === "member" ? member.status === status && member.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) : member.id === editingMember).map(member => <MemberEditor focus={view === "permission" ? permission : undefined} key={`${member.id}:${member.revision}:${state.capabilities.isOwner}`} member={member} state={state} layers={layers} busy={mutation.blocked} draft={drafts[member.id]} cancel={() => setDrafts(current => { const next = { ...current }; delete next[member.id]; return next; })} onDraft={draft => setDrafts(current => ({ ...current, [member.id]: draft }))}
      save={(operations, management) => void mutate(`memberships/${member.id}/permissions`, { expectedRevision: member.revision, operations, management }, "PUT", member.id)}
      change={action => setConfirmation({ title: action === "restore" ? "恢复成员关系" : "移除成员", action: action === "restore" ? "确认恢复" : "确认移除", destructive: action === "remove", message: action === "restore" ? "恢复成员关系和保留期内的个人层，不恢复旧权限、管理范围或分享。" : "立即撤销成员权限；断网设备已下载的内容无法即时撤回。", onConfirm: async () => { await mutate(`memberships/${member.id}`, { action, expectedRevision: member.revision }); } })}
      transfer={() => {
        const former = state.memberships.find(row => row.id === state.actorId)!;
        setConfirmation({ title: "转让拥有权", action: "确认转让", message: `将拥有权转让给「${member.displayName}」？转让后你保留的显式操作权限：${describe(former.operations, layers)}；授权管理范围：${describe(former.management, layers)}。你将不能再转让拥有权或任命受托人。`, onConfirm: async () => { await mutate("ownership", { membershipId: member.id, confirm: true }); } });
      }} />)}
    {state?.capabilities.isOwner && <AuditLog choirId={choirId!} revision={state.memberships.map(m => m.revision).join(":")} />}
    <SettingsFeedback loading={resource.loading} loadError={resource.error ? settingsError(resource.error, "成员列表更新失败，已有内容已保留。") : null} message={message} retry={() => void reload().catch(() => undefined)} />
    {(!resource.data || needsRefresh) && <Button className="secondary-button" isDisabled={busy || loading} onPress={() => void reload().catch(() => undefined)}>重新读取成员列表</Button>}
    <ConfirmDialog confirmation={confirmation} busy={busy} onClose={() => setConfirmation(null)} />
  </main></div>;
}
function PermissionPeople({ title, members }: { title: string; members: Member[] }) {
  return <section className="permission-people" aria-label={title}><h2>{title}<span>{members.length} 人</span></h2>{members.length ? <ul>{members.map(member => <li key={member.id}><span>{member.displayName}</span></li>)}</ul> : <p className="settings-copy">暂无成员</p>}</section>;
}
function describe(set: PermissionSet, layers: Layer[]): string {
  return [...set.operations.map(key => operationLabels[key]), ...(set.sharedLayers === "all" ? ["全部共享层（包括未来新增层）"] : set.sharedLayers.map(slot => layers.find(layer => layer.slot === slot)?.name ?? slot))].join("、") || "无";
}
function MemberEditor({ focus, member, state, layers, busy, save, change, transfer, draft, onDraft, cancel }: { cancel(): void; focus?: string; draft?: { operations: PermissionSet; management: PermissionSet }; onDraft: (draft: { operations: PermissionSet; management: PermissionSet }) => void; member: Member; state: State; layers: Layer[]; busy: boolean; save: (operations: PermissionSet, management: PermissionSet) => void; change: (action: "remove" | "restore") => void; transfer: () => void }) {
  const { operations, management } = draft ?? member;
  const dirty = !sameMemberPermissions({ operations, management }, member);
  const owner = state.capabilities.isOwner;
  const outsideScope = Boolean(focus && !owner && !hasPermission(state.capabilities.management, focus));
  const canAuthorize = !outsideScope && (owner || (isDelegated(state.capabilities.management) && !member.isOwner && !isDelegated(member.management) && member.id !== state.actorId));
  const protectedMember = Boolean(member.isOwner) || isDelegated(member.management);
  return <details className="lifecycle-member" open={focus ? true : undefined}><summary><span className="member-identity"><span className="member-name"><h2>{member.displayName}</h2>{member.id === state.actorId && <span className="member-self">我</span>}</span>{member.status === "removed" && <span className="member-role">已移除</span>}</span></summary>
    {Boolean(member.isOwner) && <p>云盘拥有者</p>}
    {!focus && <><p>操作权限：{describe(member.isOwner ? allPermissions() : member.operations, layers)}</p>
    <p>授权管理范围：{describe(member.isOwner ? allPermissions() : member.management, layers)}</p></>}
    {focus && <p>此项权限：{member.isOwner || hasPermission(member.operations, focus) ? "可以操作" : "不能操作"}；{member.isOwner || hasPermission(member.management, focus) ? "可以授权他人" : "不能授权他人"}</p>}
    {!canAuthorize && <p>🔒 {outsideScope ? "这项权限不在你的授权管理范围内，请联系云盘拥有者或具有此项授权管理范围的受托人。" : member.isOwner || isDelegated(member.management) ? "只有云盘拥有者可以调整拥有者或受托人的权限。" : member.id === state.actorId ? "不能自行授权，请联系云盘拥有者或相应受托权限管理者。" : "你没有授权管理范围，请联系云盘拥有者或相应受托权限管理者。"}</p>}
    {member.userDeleted ? <p>用户处于删除恢复期，须本人验证并恢复。</p> : member.status === "active" ? <>
      {canAuthorize && <>
        {member.isOwner === 1 && <p>拥有者始终具备全部能力。以下是转让后保留的显式授权。</p>}
        <details open={focus ? true : undefined}><summary>编辑权限</summary><PermissionMatrix focus={focus} operations={operations} management={management} onOperations={operations => onDraft({ operations, management })} onManagement={management => onDraft({ operations, management })} scope={owner ? allPermissions() : state.capabilities.management} owner={owner} layers={layers} disabled={busy} />
        <Button className="primary-button" isDisabled={busy || !dirty} onPress={() => save(operations, management)}>保存 {member.displayName} 的权限</Button>{dirty && <><span role="status">未保存</span><Button className="secondary-button" isDisabled={busy} onPress={cancel}>取消修改</Button></>}</details>
      </>}
      {!member.isOwner && (owner || (!protectedMember && state.capabilities.operations.operations.includes("removeMembers"))) && <details className="member-actions"><summary>成员操作</summary>
        <div className="settings-actions"><Button className="secondary-button destructive-link" isDisabled={busy} onPress={() => change("remove")}>移除 {member.displayName}</Button>
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

function sameMemberPermissions(left: { operations: PermissionSet; management: PermissionSet }, right: { operations: PermissionSet; management: PermissionSet }) {
  const same = (a: PermissionSet, b: PermissionSet) => a.operations.length === b.operations.length && a.operations.every(operation => b.operations.includes(operation))
    && (a.sharedLayers === "all" || b.sharedLayers === "all" ? a.sharedLayers === b.sharedLayers : a.sharedLayers.length === b.sharedLayers.length && a.sharedLayers.every(slot => b.sharedLayers.includes(slot)));
  return same(left.operations, right.operations) && same(left.management, right.management);
}
