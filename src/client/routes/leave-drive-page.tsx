import { DriveSettingsDialog } from "../score-library/drive-settings-dialog";
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
  const [editingName, setEditingName] = useState(false);
  const member = state?.memberships.find(member => member.choirId === choirId);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return <div className="app-page">
    <AppHeader actions={<BackButton className="header-action" to={`/choirs/${choirId}`}>返回</BackButton>} />
    <main className="page-shell settings-page settings-ux lifecycle-page">
      <header className="settings-heading"><h1>云盘个人设置</h1><p>{member?.name}</p></header>
      <section className="personal-settings-links">{member?.status === "active" && <Button className="management-nav" isDisabled={blocked} onPress={() => setEditingName(true)}><span><strong>云盘内显示名</strong><small>{member.displayName}</small></span><span>修改</span></Button>}<Link className="settings-secondary-link" to={`/choirs/${choirId}/preferences`}>阅读偏好</Link><Link className="settings-secondary-link" to={`/choirs/${choirId}/storage`}>本机存储</Link></section>
      {state && <section className="membership-exit"><h2>成员身份</h2>
        {state.memberships.filter(member => member.choirId === choirId).map((member) => <article className="lifecycle-member" key={member.id}>
          <p className="settings-copy">{member.status === "removed" ? "已退出或移除" : member.isOwner === 1 ? "你是此云盘的拥有者。" : "退出会结束你与此云盘的成员关系。"}</p>
          {member.isOwner === 1 && member.status === "active" ? <><p>拥有者必须先转让拥有权，才能退出成员身份。</p><Link className="secondary-link" to={`/choirs/${member.choirId}/memberships`}>管理成员与交接</Link></> : null}
          {member.status === "active" ? <Button className="secondary-button destructive-link" isDisabled={blocked || member.isOwner === 1} onPress={() => setConfirmation({ title: `退出「${member.name}」的成员身份`, action: "确认退出成员身份", destructive: true, message: <div className="exit-consequences"><section><h3>失去什么</h3><p>{member.isPreviewEntry ? "成员操作权限与共享层编辑权立即停止，公开体验访问仍可使用。" : "立即停止此云盘的云端访问与同步。"}</p></section><section><h3>内容还在吗</h3><p>{member.isPreviewEntry ? "我的笔记仍可使用，不进入三十天保留期。" : "云端个人层保留三十天。"}共享批注、本机下载内容和未同步草稿都会保留。</p></section><section><h3>如何恢复</h3><p>三十天内联系云盘拥有者或有成员恢复权限的人。恢复成员关系后，旧权限需要重新授权。</p></section></div>, onConfirm: () => perform(`/api/choirs/${member.choirId}/memberships/${member.id}`, { action: "remove", expectedRevision: member.revision }, async () => { await navigate("/drives"); }) })}>退出云盘成员身份</Button> : <p>三十天内可联系云盘拥有者恢复；个人层不向拥有者开放。</p>}
        </article>)}
      </section>}

      {state && !state.memberships.some(member => member.choirId === choirId) && <p>你在此云盘没有成员关系。</p>}
      <SettingsFeedback loading={loading} loadError={null} message={message} retry={() => void reload().catch(() => undefined)} />
      {message && <Button isDisabled={busy || loading} onPress={() => void reload().catch(() => undefined)}>重新读取状态</Button>}
      {editingName && <DriveSettingsDialog choirId={choirId} field="display-name" onClose={() => setEditingName(false)} onSaved={async () => { await reload(); }} />}
      <ConfirmDialog confirmation={confirmation} busy={busy} onClose={() => setConfirmation(null)} />
    </main>
  </div>;
}
