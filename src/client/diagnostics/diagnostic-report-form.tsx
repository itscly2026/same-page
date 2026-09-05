import { useEffect, useState, useSyncExternalStore } from "react";
import { type DiagnosticReader } from "../../shared/diagnostic-report";
import { clearDiagnostics, exportDiagnostics, subscribeDiagnosticReset } from "./diagnostics";
import { captureDiagnosticReport, getDiagnosticSubmission, resetDiagnosticSubmission, sendDiagnosticReport,
  setDiagnosticDescription, subscribeDiagnosticSubmission } from "./diagnostic-submission";

export function DiagnosticReportForm({ reader = null }: { reader?: DiagnosticReader | null }) {
  const submission = useSyncExternalStore(subscribeDiagnosticSubmission, getDiagnosticSubmission);
  const [previewId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState(exportDiagnostics);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const refresh = () => { setPreview(exportDiagnostics()); setMessage(""); };
    const unsubscribe = subscribeDiagnosticReset(refresh);
    const timer = setInterval(() => setPreview(exportDiagnostics()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, []);
  // Preview the complete payload (including optional text) without freezing the incident until Send.
  let current = preview;
  try { current = JSON.stringify(submission.report ?? captureDiagnosticReport(submission.description, reader, previewId), null, 2); }
  catch { /* Copying existing diagnostic categories remains available. */ }
  const copy = async (value: string, success: string) => {
    try { await navigator.clipboard.writeText(value); setMessage(success); }
    catch { setMessage("无法自动复制，请选中诊断内容或反馈编号手动复制。"); }
  };
  return <div className="diagnostic-report-form">
    <p>点击发送，将把下方诊断和你填写的描述发送给合谱维护人员，保存 30 天。不会自动上传乐谱、批注、文件名或登录凭据。</p>
    <label htmlFor="diagnostic-description">刚才遇到了什么问题？（选填）</label>
    <textarea id="diagnostic-description" rows={3} maxLength={1000} value={submission.description}
      readOnly={submission.report !== null} aria-describedby="diagnostic-description-hint"
      onChange={event => setDiagnosticDescription(event.target.value)} />
    <p id="diagnostic-description-hint" className="diagnostic-hint">请勿填写密码、验证码、邀请码或私人内容。不填写也可以发送。</p>
    <details>
      <summary>查看诊断内容</summary>
      <p>包含最近 30 分钟最多 50 条错误、应用版本、浏览器与系统版本、窗口尺寸和网络/PWA 状态；阅读器内反馈还包含显示方式、编辑状态及待同步/冲突数量。未知信息留空，联网提示不代表服务可达。</p>
      <label htmlFor="diagnostic-report">可发送给支持人员的诊断内容</label>
      <textarea id="diagnostic-report" readOnly value={current} rows={12} />
    </details>
    <div className="diagnostics-actions">
      <button className="diagnostic-send" type="button" disabled={submission.phase === "sending" || submission.phase === "sent"}
        onClick={() => { setMessage(""); void sendDiagnosticReport(reader); }}>
        {submission.phase === "sending" ? "正在发送…" : submission.phase === "sent" ? "已发送" : submission.phase === "failed" ? "重试发送" : "发送诊断"}
      </button>
      <button type="button" onClick={() => void copy(current, "已复制诊断。")}>复制诊断</button>
      {submission.report && submission.phase !== "sending" && <button type="button" onClick={() => { resetDiagnosticSubmission(); setMessage(""); }}>填写另一份反馈</button>}
      <button type="button" onClick={() => { clearDiagnostics(); setMessage("已清空本机会话诊断，不影响乐谱与草稿，也不会撤回已发送的报告。"); }}>清空诊断</button>
    </div>
    {submission.phase === "sent" && submission.report && <div className="diagnostic-receipt">
      <p>反馈编号：<code>{submission.report.id}</code></p>
      <button className="secondary-button" type="button" onClick={() => void copy(submission.report!.id, "已复制反馈编号。")}>复制反馈编号</button>
      <p>联系维护人员时提供此编号，便于查找；编号不提供报告访问权限。</p>
    </div>}
    <p role="status">{message || submission.message}</p>
    <p className="diagnostic-hint">待发送内容仅保留在当前页面会话，关闭或刷新网页、切换身份后清空。发送失败不会影响乐谱与本机草稿。</p>
  </div>;
}
