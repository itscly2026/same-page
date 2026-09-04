import { lifecycleError } from "../auth/lifecycle-error";
import { useCallback, useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";
import { userLifecycleSchema } from "../../shared/lifecycle";
import { authClient } from "../auth/auth-client";
import { AppHeader } from "../components/app-header";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { ACTIVE_LOCAL_OWNER_KEY, LAST_AUTHENTICATED_OWNER_KEY, localDatabase } from "../platform/local-database";
import { notifyReaderIdentityChange } from "../reader/reader-cache-events";

export default function UserLifecyclePage() {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const [state, setState] = useState<ReturnType<typeof userLifecycleSchema.parse> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptedUser, setAcceptedUser] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await diagnosticFetch("/api/user/lifecycle", { cache: "no-store" });
    return response.ok ? parseDiagnosticResponse(response, userLifecycleSchema) : null;
  }, []);
  const applyState = (next: ReturnType<typeof userLifecycleSchema.parse> | null) => {
    setState(next);
    if (!next) setMessage("请重新登录以管理用户或确认恢复。删除恢复期为三十天。");
  };
  const reload = () => load().then(applyState).catch(() => setMessage("暂时无法读取用户状态，请重试。"));
  useEffect(() => {
    let active = true;
    void load().then((next) => { if (active) applyState(next); })
      .catch(() => { if (active) setMessage("暂时无法读取用户状态，请重试。"); });
    return () => { active = false; };
  }, [load, session.data?.user.id]);
  const perform = async (path: string, body: unknown, complete?: () => Promise<void>) => {
    setBusy(true); setMessage(null);
    try {
      const response = await diagnosticFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        setMessage(lifecycleError(error?.error)); return;
      }
      if (complete) await complete(); else await reload();
    } catch { setMessage("未能确认操作结果，请重新读取状态后重试。"); }
    finally { setBusy(false); }
  };
  const finishDeletion = async () => {
    // Disconnect identity pointers only; drafts remain keyed to their original user.
    await localDatabase.system.bulkDelete([ACTIVE_LOCAL_OWNER_KEY, LAST_AUTHENTICATED_OWNER_KEY]);
    notifyReaderIdentityChange();
    await authClient.getSession();
    setState(null); setMessage("用户已停用。本机未同步草稿仍保留；三十天内请使用删除时的登录方式重新验证并确认恢复。");
  };
  const admins = state?.memberships.filter((member) => member.lastAdmin === 1) ?? [];
  if (state && !state.deletion && (session.isPending || session.data?.user.id !== state.userId)) return <p role="status">正在核对登录身份…</p>;
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page lifecycle-page">
    <h1>用户与成员关系</h1>
    {state ? state.deletion ? <section>
      <h2>恢复用户</h2>
      <p>用户已停用，云盘访问与同步已撤销。恢复截止：{new Date(state.deletion.expiresAt).toLocaleString()}。</p>
      <p>请使用删除时的{methodName(state.deletion.authMethod)}重新登录；验证后仍需明确确认恢复。恢复后原成员关系恢复为普通成员，管理员角色与共享层编辑权由现任管理员重新授予。</p>
      <Link className="secondary-link" to="/login">重新验证原登录方式</Link>
      <Button className="secondary-button" isDisabled={busy} onPress={() => void perform("/api/user/lifecycle/restore", { confirm: true, deletionId: state.deletion!.deletionId }, async () => { await authClient.getSession(); await navigate("/login"); })}>确认恢复用户</Button>
    </section> : <>
      <section><h2>我的云盘成员关系</h2>
        {state.memberships.map((member) => <article className="lifecycle-member" key={member.id}>
          <h3>{member.name}</h3><p>{member.displayName} · {member.status === "removed" ? "已退出或移除" : member.role === "admin" ? "管理员" : "普通成员"}</p>
          {member.role === "admin" && member.status === "active" ? <Link className="secondary-link" to={`/choirs/${member.choirId}/memberships`}>管理成员与交接</Link> : null}
          {member.status === "active" ? <Button className="secondary-button" isDisabled={busy} onPress={() => {
            if (window.confirm("退出后立即停止该成员关系的云端访问与同步；三十天内请管理员恢复。已下载内容及本机未同步草稿会保留。公开体验的本人个人层仍可使用。确认退出？")) {
              void perform(`/api/choirs/${member.choirId}/memberships/${member.id}`, { action: "remove", expectedRevision: member.revision });
            }
          }}>退出云盘</Button> : <p>三十天内可联系现任管理员恢复；个人层不向管理员开放。</p>}
        </article>)}
      </section>
      <section><h2>删除用户</h2>
        <p>删除会立即撤销所有会话、云盘访问与同步。身份和个人层保留三十天，期间可重新验证并确认恢复；到期后永久清理。共享批注保留你最后使用的云盘内显示名，不保留登录邮箱或全局资料名作为署名。</p>
        <p>已下载内容无法远程收回；本机未同步草稿会保留在原用户下，其他用户不能读取。恢复期结束后服务器无法恢复已清理的数据。</p>
        {admins.length ? <p role="alert">请先在这些云盘完成管理员交接：{admins.map((member) => member.name).join("、")}。</p> : null}
        {!state.reauthenticated ? <Button className="secondary-button" isDisabled={busy || admins.length > 0} onPress={() => void perform("/api/user/lifecycle/reauthenticate", { expectedUserId: state.userId }, async () => { await navigate("/login"); })}>重新验证原登录方式</Button> : <>
          <label className="confirmation-checkbox"><input type="checkbox" checked={acceptedUser === state.userId} onChange={(event) => setAcceptedUser(event.target.checked ? state.userId : null)} /><span>我理解删除、三十天恢复期、共享批注署名保留与本机草稿的影响。</span></label>
          <Button className="primary-button" isDisabled={busy || acceptedUser !== state.userId || admins.length > 0} onPress={() => void perform("/api/user/lifecycle/delete", { confirm: true, expectedUserId: state.userId }, finishDeletion)}>确认删除用户</Button>
        </>}
      </section>
    </> : <Link className="secondary-link" to="/login">登录或恢复用户</Link>}
    {message ? <p role="status">{message}</p> : null}
    <Button className="secondary-button" isDisabled={busy} onPress={() => void reload()}>重新读取状态</Button>
    <Link className="secondary-link" to="/">返回首页</Link>
  </main></div>;
}
function methodName(method: string) { return method === "credential" ? "邮箱与密码" : method === "google" ? "Google" : "微信"; }
