import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/app-header";
import { clearDiagnostics, exportDiagnostics, subscribeDiagnosticReset } from "./diagnostics";

export default function DiagnosticsPage() {
  const [report, setReport] = useState(exportDiagnostics);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const refresh = () => { setReport(exportDiagnostics()); setMessage(""); };
    const unsubscribe = subscribeDiagnosticReset(refresh);
    const timer = setInterval(() => setReport(exportDiagnostics()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);
  return <div className="privacy-page">
    <AppHeader />
    <main className="privacy-document">
      <h1>故障诊断</h1>
      <p>仅记录当前页面会话最近 30 分钟的错误类别、阶段、版本与错误编号，最多 50 条。不包含乐谱、批注正文、文件名、邮箱或登录凭据，不会自动上传。刷新页面或切换身份后清空。</p>
      <p>网络故障请连接网络后重试；权限拒绝请重新登录或联系云盘管理员；批注冲突请在阅读器处理。不要为排障清除站点数据，以免丢失未同步草稿。</p>
      <label htmlFor="diagnostic-report">可发送给支持人员的诊断内容</label>
      <textarea id="diagnostic-report" readOnly value={report} rows={16} style={{ width: "100%", boxSizing: "border-box" }} />
      <div className="diagnostics-actions">
        <button type="button" onClick={() => { setReport(exportDiagnostics()); setMessage(""); }}>刷新诊断</button>
        <button type="button" onClick={() => {
          const current = exportDiagnostics();
          setReport(current);
          void navigator.clipboard?.writeText(current).then(() => setMessage("已复制诊断。"), () => setMessage("无法自动复制，请选中上方文本手动复制。"));
          if (!navigator.clipboard) setMessage("无法自动复制，请选中上方文本手动复制。");
        }}>复制诊断</button>
        <button type="button" onClick={() => { clearDiagnostics(); setReport(exportDiagnostics()); setMessage("已清空诊断，不影响乐谱与草稿。"); }}>清空诊断</button>
      </div>
      <p role="status">{message}</p>
      <Link to="/">返回首页</Link>
    </main>
  </div>;
}
