import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
export default function HelpPage() {
  return <div className="app-page"><AppHeader /><main className="page-shell compact-page"><h1>帮助</h1><p>云盘内的文件、共享层和权限问题，可在“云盘管理 → 成员与权限”查找有权处理的成员。</p><p>遇到加载、显示或同步故障，可查看诊断并发送给合谱维护人员。</p><Link className="secondary-link" to="/diagnostics">故障诊断</Link></main></div>;
}
