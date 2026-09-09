import { notifyReaderIdentityChange } from "../reader/reader-cache-events";
import { rememberDriveAccessRevoked } from "../score-library/local-drive-directory";
import { authenticatedLocalOwnerKey, captureLocalWorkspaceSession, createLocalWorkspace } from "../platform/local-workspace";
import { SettingsFeedback } from "../settings/settings-feedback";
import { useState } from "react";
import { Button } from "react-aria-components";
import { Link, useNavigate, useParams } from "react-router-dom";
import { authClient } from "../auth/auth-client";
import { TaskHeader } from "../components/task-header";
import { ConfirmDialog, type Confirmation } from "../settings/confirm-dialog";
import { useUserLifecycle } from "../settings/use-user-lifecycle";

export default function LeaveDrivePage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  return <LeaveDrive key={`${session.data?.user.id ?? "guest"}:${choirId}`} choirId={choirId} />;
}
function LeaveDrive({ choirId }: { choirId: string }) {
  const navigate = useNavigate();
  const userId = authClient.useSession().data?.user.id;
  const { state, message, busy, loading, blocked, reload, perform } = useUserLifecycle();
  const member = state?.memberships.find(member => member.choirId === choirId);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  return <div className="app-page">
    <TaskHeader title={"退出云盘成员身份"} backTo={`/choirs/${choirId}`} />
    <main className="page-shell settings-page settings-ux lifecycle-page">
      <header className="settings-heading"><p>{member?.name}</p></header>
      {state && <section className="membership-exit"><h2>成员身份</h2>
        {state.memberships.filter(member => member.choirId === choirId).map((member) => <article className="lifecycle-member" key={member.id}>
          <p className="settings-copy">{member.status === "removed" ? "已退出或移除" : member.isOwner === 1 ? "你是此云盘的拥有者。" : "退出会结束你与此云盘的成员关系。"}</p>
          {member.isOwner === 1 && member.status === "active" ? <><p>拥有者必须先转让拥有权，才能退出成员身份。</p><Link className="secondary-link" to={`/choirs/${member.choirId}/memberships`}>管理成员与交接</Link></> : null}
          {member.status === "active" ? <Button className="secondary-button destructive-link" isDisabled={blocked || member.isOwner === 1} onPress={() => setConfirmation({ title: `退出「${member.name}」的成员身份`, action: "确认退出成员身份", destructive: true, message: <div className="exit-consequences"><section><h3>失去什么</h3><p>{member.isPreviewEntry ? "成员操作权限与共享层编辑权立即停止，公开体验访问仍可使用。" : "立即停止此云盘的云端访问与同步。"}</p></section><section><h3>内容还在吗</h3><p>{member.isPreviewEntry ? "我的笔记仍可使用，不进入三十天保留期。" : "云端个人层保留三十天。"}共享笔记、本机下载内容和未同步草稿都会保留。</p></section><section><h3>如何恢复</h3><p>三十天内联系云盘拥有者或有成员恢复权限的人。恢复成员关系后，旧权限需要重新授权。</p></section></div>, onConfirm: () => perform(`/api/choirs/${member.choirId}/memberships/${member.id}`, { action: "remove", expectedRevision: member.revision }, async () => {
            notifyReaderIdentityChange();
            if (userId && !member.isPreviewEntry) {
              const workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey(userId), choirId, ""));
              await rememberDriveAccessRevoked(workspace, new AbortController().signal);
            }
            await navigate("/drives");
          }) })}>退出云盘成员身份</Button> : <p>三十天内可联系云盘拥有者恢复；个人层不向拥有者开放。</p>}
        </article>)}
      </section>}

      {state && !state.memberships.some(member => member.choirId === choirId) && <p>你在此云盘没有成员关系。</p>}
      <SettingsFeedback loading={loading} loadError={null} message={message} retry={() => void reload().catch(() => undefined)} />
      {message && <Button isDisabled={busy || loading} onPress={() => void reload().catch(() => undefined)}>重新读取状态</Button>}
      <ConfirmDialog confirmation={confirmation} busy={busy} onClose={() => setConfirmation(null)} />
    </main>
  </div>;
}
