import { SettingsFeedback } from "../settings/settings-feedback";
import { authenticatedLocalOwnerKey, currentLocalOwnerKey } from "../platform/local-workspace";
import { useUserLifecycle } from "../settings/use-user-lifecycle";
import { useState } from "react";
import { Button } from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../auth/auth-client";
import { TaskHeader } from "../components/task-header";
import { ACTIVE_LOCAL_OWNER_KEY, LAST_AUTHENTICATED_OWNER_KEY, localDatabase } from "../platform/local-database";
import { notifyReaderIdentityChange } from "../reader/reader-cache-events";

export default function UserLifecyclePage() {
  const session = authClient.useSession();
  return <UserLifecycle key={session.data?.user.id ?? "recovery"} />;
}
function UserLifecycle() {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const { state, setState, message, setMessage, busy, loading, blocked, reload, perform } = useUserLifecycle();
  const [acceptedUser, setAcceptedUser] = useState<string | null>(null);
  const finishDeletion = async (isCurrent: () => boolean) => {
    // Disconnect identity pointers only; drafts remain keyed to their original user.
    await localDatabase.transaction("rw", localDatabase.system, async () => {
      if (!isCurrent() || !state || await currentLocalOwnerKey() !== authenticatedLocalOwnerKey(state.userId)) return;
      await localDatabase.system.bulkDelete([ACTIVE_LOCAL_OWNER_KEY, LAST_AUTHENTICATED_OWNER_KEY]);
    });
    if (!isCurrent()) return;
    notifyReaderIdentityChange();
    await authClient.getSession();
    if (!isCurrent()) return;
    setState(null); setMessage("用户已停用。本机未同步草稿仍保留；三十天内请使用删除时的登录方式重新验证并确认恢复。");
  };
  const ownedDrives = state?.memberships.filter((member) => member.isOwner === 1) ?? [];
  if (state && !state.deletion && (session.isPending || session.data?.user.id !== state.userId)) return <p role="status">正在核对登录身份…</p>;
  return <div className="app-page"><TaskHeader title={state?.deletion ? "恢复用户" : "删除用户"} backTo={"/user"} /><main className="page-shell settings-page settings-ux lifecycle-page">
    <header className="settings-heading"></header>
    {state ? state.deletion ? <section>
      <h2>恢复用户</h2>
      <p>用户已停用，云盘访问与同步已撤销。恢复截止：{new Date(state.deletion.expiresAt).toLocaleString()}。</p>
      <p>请使用删除时的{methodName(state.deletion.authMethod)}重新登录；验证后仍需明确确认恢复。恢复后原成员关系恢复为普通成员，拥有者角色与共享层编辑权由现任拥有者重新授予。</p>
      <Link className="secondary-link" to="/login">重新验证原登录方式</Link>
      <Button className="secondary-button" isDisabled={blocked} onPress={() => void perform("/api/user/lifecycle/restore", { confirm: true, deletionId: state.deletion!.deletionId }, async isCurrent => { await authClient.getSession(); if (isCurrent()) await navigate("/login"); })}>确认恢复用户</Button>
    </section> : <>
      <section>
        <p>删除会立即撤销所有会话、云盘访问与同步。身份和个人层保留三十天，期间可重新验证并确认恢复；到期后永久清理。共享笔记保留你最后使用的云盘内显示名，不保留登录邮箱或全局资料名作为署名。</p>
        <p>已下载内容无法远程收回；本机未同步草稿会保留在原用户下，其他用户不能读取。恢复期结束后服务器无法恢复已清理的数据。</p>
        {ownedDrives.length ? <p role="alert">请先在这些云盘完成拥有权转让：{ownedDrives.map((member) => member.name).join("、")}。</p> : null}
        {!state.reauthenticated ? <Button className="secondary-button" isDisabled={blocked || ownedDrives.length > 0} onPress={() => void perform("/api/user/lifecycle/reauthenticate", { expectedUserId: state.userId }, async () => { await navigate("/login"); })}>重新验证原登录方式</Button> : <>
          <label className="confirmation-checkbox"><input type="checkbox" checked={acceptedUser === state.userId} onChange={(event) => setAcceptedUser(event.target.checked ? state.userId : null)} /><span>我理解删除、三十天恢复期、共享笔记署名保留与本机草稿的影响。</span></label>
          <Button className="primary-button" isDisabled={blocked || acceptedUser !== state.userId || ownedDrives.length > 0} onPress={() => void perform("/api/user/lifecycle/delete", { confirm: true, expectedUserId: state.userId }, finishDeletion)}>确认删除用户</Button>
        </>}
      </section>
    </> : !loading && <Link className="secondary-link" to="/login">登录或恢复用户</Link>}
    <SettingsFeedback loading={loading} loadError={null} message={message} retry={() => void reload().catch(() => undefined)} />
    {message && <Button className="secondary-button" isDisabled={busy || loading} onPress={() => void reload().catch(() => undefined)}>重新读取状态</Button>}
  </main></div>;
}
function methodName(method: string) { return method === "credential" ? "邮箱与密码" : "Google"; }
