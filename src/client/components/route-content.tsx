import { ReaderLoading } from "../navigation/reader-loading";
import { Component, Suspense, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { AppHeader } from "./app-header";

export function RouteContent({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <RouteErrorBoundary key={pathname} fallback={<RouteFeedback failed />}>
    <Suspense fallback={<RouteFeedback />}>{children}</Suspense>
  </RouteErrorBoundary>;
}

function RouteFeedback({ failed = false }: { failed?: boolean }) {
  const { pathname } = useLocation();
  const drive = pathname.match(/^\/choirs\/([^/]+)/)?.[1];
  if (!failed && pathname.includes("/scores/") && drive) return <ReaderLoading choirId={drive} />;
  const title = pathname.includes("/scores/") ? "乐谱阅读器"
    : pathname.endsWith("/preferences") ? "阅读偏好"
    : pathname.includes("/shared-layers") ? "共享层管理"
    : pathname.endsWith("/memberships") ? "成员管理"
    : pathname === "/login" ? "登录"
    : pathname === "/user/lifecycle" ? "用户删除与恢复"
    : pathname.endsWith("/me") ? "云盘个人设置"
    : pathname === "/user" ? "个人设置"
    : pathname.includes("/settings/") ? "云盘设置"
    : pathname === "/help" ? "帮助"
    : pathname === "/about" ? "关于合谱"
    : pathname === "/diagnostics" ? "故障诊断"
    : pathname === "/privacy" ? "隐私说明" : drive ? "乐谱云盘" : "合谱";
  return <main className="page-shell">
    <AppHeader />
    <h1>{title}</h1>
    <p role={failed ? "alert" : "status"}>{failed ? `${title}加载失败，请重试。` : `正在加载${title}…`}</p>
    <Link className="text-button" state={{ home: true }} to={drive && pathname !== `/choirs/${drive}` ? `/choirs/${drive}` : "/"}>{drive && pathname !== `/choirs/${drive}` ? "返回云盘" : "返回首页"}</Link>
    {failed && <Link className="secondary-link" to="/diagnostics">故障诊断</Link>}
    {failed && <button className="secondary-button" onClick={() => window.location.reload()}>重新加载页面</button>}
  </main>;
}

class RouteErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
