import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
import { DiagnosticReportForm } from "./diagnostic-report-form";

export default function DiagnosticsPage() {
  return <div className="privacy-page">
    <AppHeader />
    <main className="privacy-document diagnostics-document">
      <h1>故障诊断</h1>
      <p>没有错误记录也可以反馈，问题描述选填。</p>
      <DiagnosticReportForm />
      <details className="diagnostic-help"><summary>常见问题恢复建议</summary><p>网络故障请连接网络后重试；权限拒绝请重新登录或联系云盘拥有者；笔记冲突请在阅读器处理。不要为排障清除站点数据，以免丢失未同步草稿。</p></details>
      <Link to="/" state={{ home: true }}>返回首页</Link>
    </main>
  </div>;
}
