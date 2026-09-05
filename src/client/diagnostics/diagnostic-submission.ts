import { diagnosticReceiptSchema, diagnosticReportSchema, type DiagnosticReader, type DiagnosticReport } from "../../shared/diagnostic-report";
import { exportDiagnostics, subscribeDiagnosticReset } from "./diagnostics";

// Only parsed, bounded tokens leave this function; never retain a raw user agent.
export function diagnosticEnvironment(ua = navigator.userAgent): DiagnosticReport["environment"] {
  const browserPatterns = [
    ["edge", /(?:Edg|EdgiOS|EdgA)\/([\d.]+)/], ["firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["chrome", /(?:Chrome|CriOS)\/([\d.]+)/], ["safari", /Version\/([\d.]+).*Safari/],
  ] as const;
  const systemPatterns = [
    ["ios", /(?:iPhone OS|CPU OS) ([\d_]+)/], ["android", /Android ([\d.]+)/],
    ["macos", /Mac OS X ([\d_.]+)/], ["windows", /Windows NT ([\d.]+)/],
  ] as const;
  const browser = browserPatterns.find(([, pattern]) => pattern.test(ua));
  const system = systemPatterns.find(([, pattern]) => pattern.test(ua));
  const safeVersion = (value?: string) => value && /^\d{1,4}(?:[._]\d{1,6}){0,3}$/.test(value) ? value.replaceAll("_", ".") : null;
  // iPadOS may advertise a desktop Mac UA. Detect the family without inventing its OS version.
  const desktopIPad = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return {
    browser: browser?.[0] ?? "unknown", browserVersion: safeVersion(browser?.[1].exec(ua)?.[1]),
    system: desktopIPad ? "ios" : system?.[0] ?? (/Linux/.test(ua) ? "linux" : "unknown"),
    systemVersion: desktopIPad ? null : safeVersion(system?.[1].exec(ua)?.[1]),
    viewportWidth: Math.min(32768, Math.max(0, Math.round(window.innerWidth))),
    viewportHeight: Math.min(32768, Math.max(0, Math.round(window.innerHeight))),
    standalone: window.matchMedia?.("(display-mode: standalone)").matches === true || ("standalone" in navigator && navigator.standalone === true),
    serviceWorkerControlled: !!navigator.serviceWorker?.controller,
    onlineHint: navigator.onLine,
  };
}

export function captureDiagnosticReport(description: string, reader: DiagnosticReader | null, id = crypto.randomUUID()): DiagnosticReport {
  return diagnosticReportSchema.parse({ ...JSON.parse(exportDiagnostics()), id,
    description, environment: diagnosticEnvironment(), reader });
}

type Submission = {
  description: string;
  report: DiagnosticReport | null;
  phase: "idle" | "sending" | "failed" | "sent";
  message: string;
};
const empty = (): Submission => ({ description: "", report: null, phase: "idle", message: "" });
let state = empty();
let epoch = 0;
let pending: AbortController | null = null;
const listeners = new Set<() => void>();
function update(next: Submission) { state = next; for (const listener of listeners) listener(); }
export const getDiagnosticSubmission = () => state;
export function subscribeDiagnosticSubmission(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function resetDiagnosticSubmission() {
  epoch += 1;
  pending?.abort();
  pending = null;
  update(empty());
}
subscribeDiagnosticReset(resetDiagnosticSubmission);
export function setDiagnosticDescription(description: string) {
  if (state.report || state.phase !== "idle") return;
  update({ ...state, description: description.slice(0, 1000) });
}

export async function sendDiagnosticReport(reader: DiagnosticReader | null) {
  if (state.phase === "sending" || state.phase === "sent") return;
  let report: DiagnosticReport;
  try { report = state.report ?? captureDiagnosticReport(state.description, reader); }
  catch { update({ ...state, message: "暂时无法准备诊断，请复制已有诊断内容。" }); return; }
  const started = ++epoch;
  update({ ...state, report, phase: "sending", message: "正在发送诊断…" });
  const controller = new AbortController();
  pending = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    if (!navigator.onLine) throw new Error("offline");
    // Deliberately outside diagnosticFetch: a failed submission must not report itself or retry business writes.
    const response = await fetch("/api/diagnostic-reports", { method: "POST", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(report), signal: controller.signal });
    if (started !== epoch) return;
    if (response.status === 429) {
      update({ ...state, phase: "failed", message: "发送过于频繁，请稍后重试。当前诊断仍保留，也可复制。" });
      return;
    }
    if (!response.ok) throw new Error("unconfirmed");
    const receipt = diagnosticReceiptSchema.parse(await response.json());
    if (started !== epoch) return;
    if (receipt.id !== report.id) throw new Error("invalid_receipt");
    update({ ...state, phase: "sent", message: "已发送给合谱维护人员。" });
  } catch {
    if (started !== epoch) return;
    update({ ...state, phase: "failed", message: navigator.onLine
      ? "尚未确认收到诊断。当前内容仍保留，可重试或复制；重试不会重复创建反馈。"
      : "当前离线，尚未确认收到诊断。请联网后重试，也可复制当前内容；重试不会重复创建反馈。" });
  } finally {
    clearTimeout(timeout);
    if (started === epoch) pending = null;
  }
}
