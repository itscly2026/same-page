import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
import { DiagnosticReportForm } from "./diagnostic-report-form";

export default function DiagnosticsPage() {
  return <div className="privacy-page">
    <AppHeader />
    <main className="privacy-document">
      <h1>故障诊断</h1>
      <p>遇到问题时，可以直接发送诊断帮助我们排查。没有错误记录也可以反馈。</p>
      <p>网络故障请连接网络后重试；权限拒绝请重新登录或联系云盘管理员；批注冲突请在阅读器处理。不要为排障清除站点数据，以免丢失未同步草稿。</p>
      <DiagnosticReportForm />
      <Link to="/">返回首页</Link>
    </main>
  </div>;
}
