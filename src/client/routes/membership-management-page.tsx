import { BackButton } from "../navigation/back-button";
import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useParams } from "react-router-dom";
import { managedMembershipsSchema } from "../../shared/lifecycle";
import { AppHeader } from "../components/app-header";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { lifecycleError } from "../auth/lifecycle-error";

export default function MembershipManagementPage() {
  const { choirId } = useParams();
  const [members, setMembers] = useState<ReturnType<typeof managedMembershipsSchema.parse>["memberships"]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/memberships`);
    if (!response.ok) throw new Error("membership_access_denied");
    return (await parseDiagnosticResponse(response, managedMembershipsSchema)).memberships;
  }, [choirId]);
  const applyMembers = (next: ReturnType<typeof managedMembershipsSchema.parse>["memberships"]) => {
    setMembers(next);
  };
  const reload = () => load().then(applyMembers).catch(() => { setMembers([]); setMessage("成员列表加载失败或权限已撤销，请重试。"); });
  useEffect(() => {
    let active = true;
    void load().then((next) => { if (active) applyMembers(next); })
      .catch(() => { if (active) { setMembers([]); setMessage("成员列表加载失败或权限已撤销，请重试。"); } });
    return () => { active = false; };
  }, [load]);
  const change = async (member: (typeof members)[number], action: string) => {
    if (!window.confirm(action === "restore" ? "恢复为普通成员；个人层只向本人开放，不恢复原管理员角色或编辑授权。确认恢复？" : action === "promote" ? "此成员将能管理当前云盘的成员、共享批注和乐谱。确认授予管理员？" : "这会撤销相应云盘权限，已下载数据和本机草稿不会被删除。确认继续？")) return;
    setBusy(true); setMessage(null);
    try {
      const response = await diagnosticFetch(`/api/choirs/${choirId}/memberships/${member.id}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, expectedRevision: member.revision }),
      });
      if (!response.ok) setMessage(lifecycleError((await response.json()).error));
      await reload();
    } catch { setMessage("操作结果未确认，请重新读取成员列表。"); }
    finally { setBusy(false); }
  };
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page lifecycle-page">
    <h1>成员管理与交接</h1><p>退出或移除立即撤销成员权限；三十天内可恢复同一成员关系。管理员不能读取成员个人层。交接时先授予另一成员管理员，再退出或降为普通成员。</p>
    {members.map((member) => <article className="lifecycle-member" key={member.id}>
      <h2>{member.displayName}</h2><p>{member.status === "active" ? member.role === "admin" ? "管理员" : "普通成员" : "已移除"}</p>
      {member.userDeleted ? <p>用户处于删除恢复期，须本人重新验证并确认恢复。</p> : member.status === "active" ? <>
        <Button className="secondary-button" isDisabled={busy} onPress={() => void change(member, member.role === "admin" ? "demote" : "promote")}>{member.role === "admin" ? "降为普通成员" : "授予管理员"}</Button>
        <Button className="secondary-button" isDisabled={busy} onPress={() => void change(member, "remove")}>移除成员</Button>
      </> : <Button className="secondary-button" isDisabled={busy || member.recoverable !== 1} onPress={() => void change(member, "restore")}>恢复成员关系</Button>}
    </article>)}
    {message ? <p role="status">{message}</p> : null}
    <Button className="secondary-button" isDisabled={busy} onPress={() => void reload().catch(() => setMessage("成员列表加载失败，请重试。"))}>重新读取成员列表</Button>
    <BackButton className="secondary-link" to={`/choirs/${choirId}`}>返回云盘</BackButton>
  </main></div>;
}
