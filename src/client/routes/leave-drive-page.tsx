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
    <AppHeader actions={<BackButton className="header-action" to={`/choirs/${choirId}`}>返回</BackButton>} />
    <main className="page-shell settings-page settings-ux lifecycle-page">
      <header className="settings-heading"><h1>云盘个人设置</h1></header>
      <section className="personal-settings-links"><Link className="settings-secondary-link" to={`/choirs/${choirId}/preferences`}>阅读偏好</Link><Link className="settings-secondary-link" to={`/choirs/${choirId}/storage`}>本机存储</Link></section>
      {state && <section className="membership-exit"><h2>退出云盘成员身份</h2>
        {state.memberships.filter(member => member.choirId === choirId).map((member) => <article className="lifecycle-member" key={member.id}>
          <h3>{member.name}</h3><p>{member.displayName} · {member.status === "removed" ? "已退出或移除" : member.isOwner === 1 ? "拥有者" : "普通成员"}</p>
          {member.isOwner === 1 && member.status === "active" ? <><p>拥有者必须先转让拥有权，才能退出成员身份。</p><Link className="secondary-link" to={`/choirs/${member.choirId}/memberships`}>管理成员与交接</Link></> : null}
          {member.status === "active" ? <Button className="secondary-button" isDisabled={blocked || member.isOwner === 1} onPress={() => setConfirmation({ title: `退出「${member.name}」的成员身份`, action: "确认退出成员身份", message: `退出「${member.name}」后立即停止该成员关系的云端访问与同步；普通云盘的云端个人层保留三十天，期间请拥有者或有成员恢复权限的人恢复；共享批注保留。已下载内容及本机未同步草稿会保留。如果这是公开体验云盘，退出后仍有公开体验访问，本人个人层仍可使用且不进入三十天保留期，但成员操作权限与共享层编辑权立即撤销。`, onConfirm: () => perform(`/api/choirs/${member.choirId}/memberships/${member.id}`, { action: "remove", expectedRevision: member.revision }, async () => { await navigate("/drives"); }) })}>退出云盘成员身份</Button> : <p>三十天内可联系云盘拥有者恢复；个人层不向拥有者开放。</p>}
        </article>)}
      </section>}

      {state && !state.memberships.some(member => member.choirId === choirId) && <p>你在此云盘没有成员关系。</p>}
      <SettingsFeedback loading={loading} loadError={null} message={message} retry={() => void reload().catch(() => undefined)} />
      {message && <Button isDisabled={busy || loading} onPress={() => void reload().catch(() => undefined)}>重新读取状态</Button>}
      <ConfirmDialog confirmation={confirmation} busy={busy} onClose={() => setConfirmation(null)} />
    </main>
  </div>;
}
