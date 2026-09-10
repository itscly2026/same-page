import { authClient } from "../auth/auth-client";
import { useLogout } from "../auth/logout-context";
import { Link } from "react-router-dom";
import { TaskHeader } from "../components/task-header";

export default function PersonalSettingsPage() {
  const session = authClient.useSession();
  const logout = useLogout();
  const email = session.data?.user.email;
  return <div className="app-page">
    <TaskHeader title={"账户"} backTo={"/drives"} />
    <main className="page-shell settings-page settings-ux">
      <header className="settings-heading"></header>
      <section className="personal-settings-links">
        <p className="settings-copy">阅读偏好和显示名在各云盘中分别设置。</p>
        <p>{email || "已登录"}</p><button className="secondary-button" onClick={() => void logout.request()}>退出登录</button>
        <h2>用户与数据</h2><Link className="settings-secondary-link settings-danger-link" to="/user/lifecycle">删除用户<span aria-hidden="true">›</span></Link>
      </section>
    </main>
  </div>;
}
