import { authClient } from "../auth/auth-client";
import { BackButton } from "../navigation/back-button";
import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useParams } from "react-router-dom";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { allPermissions, isDelegated, operationKeys, operationLabels, type PermissionSet } from "../../shared/drive-permissions";
import { AppHeader } from "../components/app-header";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { lifecycleError } from "../auth/lifecycle-error";

type State = ReturnType<typeof managedMembershipsSchema.parse>;
type Member = State["memberships"][number];
type Layer = { slot: string; name: string };
export default function MembershipManagementPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <MembershipManagement key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}
function MembershipManagement({ choirId }: { choirId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/memberships`);
    if (!response.ok) throw new Error("membership_access_denied");
    const next = await parseDiagnosticResponse(response, managedMembershipsSchema);
    const definitions = await diagnosticFetch(`/api/choirs/${choirId}/permission-layers`);
    if (!definitions.ok) throw new Error("membership_access_denied");
    return { next, layers: (await definitions.json()).layers as Layer[] };
  }, [choirId]);
  useEffect(() => {
    let active = true;
    void load().then(({ next, layers }) => { if (active) { setState(next); setLayers(layers); } })
      .catch(() => { if (active) setMessage("成员列表加载失败或权限已撤销，请重试。"); });
    return () => { active = false; };
  }, [load]);
  const reload = async () => { const next = await load(); setState(next.next); setLayers(next.layers); };
  const mutate = async (path: string, body: unknown, method = "POST") => {
    setBusy(true); setMessage(null);
    try {
      const response = await diagnosticFetch(`/api/choirs/${choirId}/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) setMessage(lifecycleError((await response.json()).error));
      else setMessage("已保存。");
      await reload();
    } catch { setState(null); setMessage("操作结果未确认，请重新读取成员列表。"); }
    finally { setBusy(false); }
  };
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page lifecycle-page">
    <h1>成员与权限</h1><p>操作权限与授权管理范围分别设置。拥有者和受托人都不能读取未分享的个人层，不能编辑他人的个人层。</p>
    {state?.memberships.map(member => <MemberEditor key={`${member.id}:${member.revision}:${state.capabilities.isOwner}`} member={member} state={state} layers={layers} busy={busy}
      save={(operations, management) => void mutate(`memberships/${member.id}/permissions`, { expectedRevision: member.revision, operations, management }, "PUT")}
      change={action => { if (window.confirm(action === "restore" ? "恢复成员关系和保留期内的个人层，不恢复旧权限、管理范围或分享。确认恢复？" : "立即撤销成员权限；断网设备已下载的内容无法即时撤回。确认移除？")) void mutate(`memberships/${member.id}`, { action, expectedRevision: member.revision }); }}
      transfer={() => {
        const former = state.memberships.find(row => row.id === state.actorId)!;
        if (window.confirm(`将拥有权转让给「${member.displayName}」？转让后你保留的显式操作权限：${describe(former.operations, layers)}；授权管理范围：${describe(former.management, layers)}。你将不能再转让拥有权或任命受托人。`)) void mutate("ownership", { membershipId: member.id, confirm: true });
      }} />)}
    {state?.capabilities.isOwner && <AuditLog choirId={choirId!} revision={state.memberships.map(m => m.revision).join(":")} />}
    {message && <p role="status">{message}</p>}
    <Button className="secondary-button" isDisabled={busy} onPress={() => void reload().catch(() => { setState(null); setMessage("成员列表加载失败，请重试。"); })}>重新读取成员列表</Button>
    <BackButton className="secondary-link" to={`/choirs/${choirId}`}>返回云盘</BackButton>
  </main></div>;
}
function describe(set: PermissionSet, layers: Layer[]): string {
  return [...set.operations.map(key => operationLabels[key]), ...(set.sharedLayers === "all" ? ["全部共享层（包括未来新增层）"] : set.sharedLayers.map(slot => layers.find(layer => layer.slot === slot)?.name ?? slot))].join("、") || "无";
}
function MemberEditor({ member, state, layers, busy, save, change, transfer }: { member: Member; state: State; layers: Layer[]; busy: boolean; save: (operations: PermissionSet, management: PermissionSet) => void; change: (action: "remove" | "restore") => void; transfer: () => void }) {
  const [operations, setOperations] = useState(member.operations);
  const [management, setManagement] = useState(member.management);
  const owner = state.capabilities.isOwner;
  const canAuthorize = owner || isDelegated(state.capabilities.management);
  const protectedMember = Boolean(member.isOwner) || isDelegated(member.management);
  return <details className="lifecycle-member"><summary><h2>{member.displayName}</h2></summary>
    <p>{member.status === "removed" ? "已移除" : member.isOwner ? "拥有者" : isDelegated(member.management) ? "受托权限管理者" : "普通成员"}</p>
    {member.userDeleted ? <p>用户处于删除恢复期，须本人验证并恢复。</p> : member.status === "active" ? <>
      {canAuthorize && <>
        {member.isOwner === 1 && <p>拥有者始终具备全部能力。以下是转让后保留的显式授权。</p>}
        {owner && <Button className="secondary-button" isDisabled={busy} onPress={() => { setOperations(allPermissions()); setManagement(allPermissions()); }}>全部日常管理</Button>}
        <PermissionFields label="可以做什么" value={operations} onChange={setOperations} scope={owner ? allPermissions() : state.capabilities.management} layers={layers} disabled={busy} />
        {owner && <PermissionFields label="可以管理哪些授权" value={management} onChange={setManagement} scope={allPermissions()} layers={layers} disabled={busy} />}
        <Button className="primary-button" isDisabled={busy} onPress={() => save(operations, management)}>保存 {member.displayName} 的权限</Button>
      </>}
      {!member.isOwner && (owner || (!protectedMember && state.capabilities.operations.operations.includes("removeMembers"))) && <Button className="secondary-button" isDisabled={busy} onPress={() => change("remove")}>移除 {member.displayName}</Button>}
      {owner && !member.isOwner && <Button className="secondary-button" isDisabled={busy} onPress={transfer}>转让拥有权给 {member.displayName}</Button>}
    </> : (owner || state.capabilities.operations.operations.includes("removeMembers")) && <Button className="secondary-button" isDisabled={busy || member.recoverable !== 1} onPress={() => change("restore")}>恢复 {member.displayName} 的成员关系</Button>}
  </details>;
}
function PermissionFields({ label, value, scope, layers, disabled, onChange }: { label: string; value: PermissionSet; scope: PermissionSet; layers: Layer[]; disabled: boolean; onChange: (next: PermissionSet) => void }) {
  const groups = [{ name: "文件", keys: operationKeys.slice(0, 3) }, { name: "成员", keys: operationKeys.slice(3, 5) }, { name: "共享层配置", keys: operationKeys.slice(5, 6) }, { name: "云盘设置", keys: operationKeys.slice(6) }];
  return <fieldset disabled={disabled} className="permission-fields"><legend>{label}</legend>
    {groups.map(group => { const keys = group.keys.filter(key => scope.operations.includes(key)); return keys.length > 0 && <div key={group.name}><strong>{group.name}</strong> <button type="button" className="text-button" onClick={() => onChange({ ...value, operations: [...new Set([...value.operations, ...keys])] })}>{group.name}全选</button>
      {keys.map(key => <label key={key}><input type="checkbox" checked={value.operations.includes(key)} onChange={event => onChange({ ...value, operations: event.target.checked ? [...value.operations, key] : value.operations.filter(item => item !== key) })} />{operationLabels[key]}</label>)}</div>; })}
    <div><strong>编辑指定共享层</strong>
      {scope.sharedLayers === "all" && <label><input type="checkbox" checked={value.sharedLayers === "all"} onChange={event => onChange({ ...value, sharedLayers: event.target.checked ? "all" : [] })} />全部共享层（包括未来新增层）</label>}
      {layers.filter(layer => scope.sharedLayers === "all" || scope.sharedLayers.includes(layer.slot)).map(layer => <label key={layer.slot}><input type="checkbox" disabled={value.sharedLayers === "all"} checked={value.sharedLayers === "all" || value.sharedLayers.includes(layer.slot)} onChange={event => { if (value.sharedLayers !== "all") onChange({ ...value, sharedLayers: event.target.checked ? [...value.sharedLayers, layer.slot] : value.sharedLayers.filter(slot => slot !== layer.slot) }); }} />{layer.name}</label>)}
    </div>
  </fieldset>;
}
function AuditLog({ choirId, revision }: { choirId: string; revision: string }) {
  const [entries, setEntries] = useState<Array<{ id: string; actorName: string; targetName: string; before: string; after: string; createdAt: number }>>([]);
  useEffect(() => { let active = true; void diagnosticFetch(`/api/choirs/${choirId}/permission-changes`).then(response => response.ok ? response.json() : Promise.reject()).then(data => { if (active) setEntries(data.changes); }).catch(() => { if (active) setEntries([]); }); return () => { active = false; }; }, [choirId, revision]);
  return <details><summary>最近权限变更记录</summary>{entries.map(entry => <article key={entry.id}><p>{entry.actorName} → {entry.targetName} · {new Date(entry.createdAt).toLocaleString()}</p><p>变更前：{auditDescription(entry.before)}</p><p>变更后：{auditDescription(entry.after)}</p></article>)}</details>;
}
function auditDescription(json: string): string {
  const entry = JSON.parse(json);
  return entry.ownerMembershipId ? "拥有权转让" : `操作：${describe(entry.operations, [])}；管理范围：${describe(entry.management, [])}`;
}
