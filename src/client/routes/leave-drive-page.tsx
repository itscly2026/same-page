import { SettingsFeedback } from "../settings/settings-feedback";
import { useState } from "react";
import { Button } from "react-aria-components";
import { Link, useNavigate, useParams } from "react-router-dom";
import { authClient } from "../auth/auth-client";
import { AppHeader } from "../components/app-header";
import { BackButton } from "../navigation/back-button";
import { ConfirmDialog, type Confirmation } from "../settings/confirm-dialog";
import { useUserLifecycle } from "../settings/use-user-lifecycle";

export default function LeaveDrivePage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <LeaveDrive key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}
function LeaveDrive({ choirId }: { choirId: string }) {
  const navigate = useNavigate();
  const { state, message, busy, loading, blocked, reload, perform } = useUserLifecycle();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return <div className="app-page">
    <AppHeader actions={<BackButton className="header-action" to={`/choirs/${choirId}`}>返回云盘</BackButton>} />
    <main className="page-shell settings-page settings-ux lifecycle-page">
      <header className="settings-heading"><h1>退出此云盘</h1></header>
      {state && <section><h2>此云盘成员关系</h2>
        {state.memberships.filter(member => member.choirId === choirId).map((member) => <article className="lifecycle-member" key={member.id}>
          <h3>{member.name}</h3><p>{member.displayName} · {member.status === "removed" ? "已退出或移除" : member.isOwner === 1 ? "拥有者" : "普通成员"}</p>
          {member.isOwner === 1 && member.status === "active" ? <Link className="secondary-link" to={`/choirs/${member.choirId}/memberships`}>管理成员与交接</Link> : null}
          {member.status === "active" ? <Button className="secondary-button" isDisabled={blocked || member.isOwner === 1} onPress={() => setConfirmation({ title: "退出此云盘", action: "确认退出", message: "退出后立即停止该成员关系的云端访问与同步；三十天内请有成员恢复权限的人恢复。已下载内容及本机未同步草稿会保留。公开体验的本人个人层仍可使用。", onConfirm: () => perform(`/api/choirs/${member.choirId}/memberships/${member.id}`, { action: "remove", expectedRevision: member.revision }, async () => { await navigate("/drives"); }) })}>退出云盘</Button> : <p>三十天内可联系云盘拥有者恢复；个人层不向拥有者开放。</p>}
        </article>)}
      </section>}

      {state && !state.memberships.some(member => member.choirId === choirId) && <p>你在此云盘没有成员关系。</p>}
      <SettingsFeedback loading={loading} loadError={null} message={message} retry={() => void reload().catch(() => undefined)} />
      {message && <Button isDisabled={busy || loading} onPress={() => void reload().catch(() => undefined)}>重新读取状态</Button>}
      <ConfirmDialog confirmation={confirmation} busy={busy} onClose={() => setConfirmation(null)} />
    </main>
  </div>;
}
