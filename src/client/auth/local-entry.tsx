import "./local-entry.css";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
import { LocalLibrary } from "../score-library/local-library";
import type { ApplicationIdentity } from "./application-identity";

export function IdentityNotice({ identity }: { identity: ApplicationIdentity }) {
  if (identity.onlineState === "authenticated") return null;
  return <p role="status">{identity.onlineState === "checking" ? "正在连接，已保存的内容可以继续使用。"
    : identity.onlineState === "unreachable" ? "暂时无法连接，已保存的内容仍然保留。"
    : "重新登录后同步，已保存的内容可以继续使用。"}
    {identity.onlineState === "signed-out" ? <> <Link to="/login">重新登录</Link></> : null}
    {identity.onlineState === "unreachable" ? <> <button className="text-button" onClick={() => void identity.session.refetch()}>重试连接</button></> : null}
  </p>;
}

export function LocalEntry({ identity, choirId }: { identity: ApplicationIdentity; choirId?: string }) {
  return <div className="app-page local-entry"><AppHeader /><main className="page-shell">
    <h1>本机内容</h1><IdentityNotice identity={identity} />
    {identity.localUserId ? <LocalLibrary userId={identity.localUserId} choirId={choirId} />
      : <p>{identity.restoring || identity.onlineState === "checking" ? "正在恢复本机内容…" : "本机没有可恢复的用户内容，请联网后重试。"}</p>}
  </main></div>;
}
