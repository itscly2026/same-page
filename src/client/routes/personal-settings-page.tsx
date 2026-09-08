import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
import { BackButton } from "../navigation/back-button";

export default function PersonalSettingsPage() {
  return <div className="app-page">
    <AppHeader actions={<BackButton className="header-action" to="/drives">返回</BackButton>} />
    <main className="page-shell settings-page settings-ux">
      <header className="settings-heading"><h1>个人设置</h1></header>
      <section className="personal-settings-links">
        <p className="settings-copy">阅读偏好和显示名在各云盘中分别设置。</p>
        <Link className="settings-secondary-link" to="/drives">我已加入的云盘<span aria-hidden="true">›</span></Link>
        <Link className="settings-secondary-link settings-danger-link" to="/user/lifecycle">删除用户<span aria-hidden="true">›</span></Link>
      </section>
    </main>
  </div>;
}
