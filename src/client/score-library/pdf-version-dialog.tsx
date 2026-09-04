import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { scoreVersionHistorySchema, scoreVersionSummarySchema, type ScoreSummary, type ScoreVersionHistory } from "../../shared/scores";
import { authClient } from "../auth/auth-client";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { LibraryDialogHeading } from "./library-dialog-heading";
import { uploadMessage } from "./library-format";
import { PdfVersionPreview } from "./pdf-version-preview";

type Version = ScoreSummary["currentVersion"];
export function PdfVersionDialog({ choirId, score, historyOnly, onClose, onComplete }: {
  choirId: string; score: ScoreSummary; historyOnly: boolean;
  onClose(): void; onComplete(message: string): void | Promise<void>;
}) {
  const session = authClient.useSession();
  const [initialUser] = useState(session.data?.user.id);
  const path = `/api/choirs/${choirId}/scores/${score.id}`;
  const [history, setHistory] = useState<ScoreVersionHistory | null>(null);
  const [selected, setSelected] = useState<Version | null>(null);
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const candidate = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void diagnosticFetch(`${path}/versions`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("history_unavailable");
      const result = await parseDiagnosticResponse(response, scoreVersionHistorySchema);
      if (mounted.current) setHistory(result);
    }).catch(() => { if (mounted.current) setMessage("版本信息加载失败，请关闭后重试。"); });
    return () => {
      mounted.current = false;
      controller.abort();
      if (candidate.current) void diagnosticFetch(`${path}/versions/${candidate.current}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
  }, [path]);
  const upload = async (file: File) => {
    if (!history) return;
    setBusy(true); setMessage(null);
    try {
      const form = new FormData(); form.set("file", file); form.set("expectedRevision", String(history.revision));
      const response = await diagnosticFetch(`${path}/versions`, { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(uploadMessage(response.status, payload));
      const version = scoreVersionSummarySchema.parse(payload.version);
      candidate.current = version.id;
      if (!mounted.current) {
        await diagnosticFetch(`${path}/versions/${version.id}`, { method: "DELETE" });
        return;
      }
      setSelected(version); setReady(false); setAccepted(false);
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "上传失败，请重试。"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const publish = async () => {
    if (!history || !selected) return;
    setBusy(true); setMessage(null);
    try {
      const response = await diagnosticFetch(`${path}/versions/${selected.id}/publish`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: history.revision }),
      });
      if (!response.ok) { setMessage(uploadMessage(response.status, await response.json())); return; }
      candidate.current = null;
      await onComplete(historyOnly ? "已回滚 PDF；批注仍使用原页码和坐标。" : "PDF 已替换；批注仍使用原页码和坐标。");
    } catch { setMessage("未能确认发布结果，请重试或重新打开版本记录核对。"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const currentPages = history?.versions.find((version) => version.id === history.currentVersionId)?.pageCount ?? score.currentVersion.pageCount;
  if (session.isPending || !initialUser || initialUser !== session.data?.user.id) return <p role="alert">登录身份已变化，请关闭后重新打开版本工具。<Button className="secondary-button" onPress={onClose}>关闭</Button></p>;
  return <ModalOverlay className="modal-overlay" isOpen isDismissable={!busy} isKeyboardDismissDisabled={busy}
    onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Modal className="app-modal"><Dialog className="app-dialog pdf-version-dialog">
      <LibraryDialogHeading title={historyOnly ? "历史 PDF 版本" : "替换 PDF"} close={() => { if (!busy) onClose(); }} />
      {!historyOnly && !selected ? <label>新的 PDF（最多 20 MB、500 页）
        <input type="file" accept="application/pdf,.pdf" disabled={!history || busy}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
      </label> : null}
      {historyOnly ? <label>选择三十天保留期内的版本
        <select aria-label="历史 PDF 版本" disabled={!history || busy} value={selected?.id ?? ""}
          onChange={(event) => { setSelected(history?.versions.find((version) => version.id === event.target.value) ?? null); setReady(false); setAccepted(false); }}>
          <option value="">请选择版本</option>
          {history?.versions.filter((version) => version.id !== history.currentVersionId).map((version) =>
            <option key={version.id} value={version.id}>版本 {version.versionNumber} · {version.pageCount} 页 · {new Date(version.createdAt).toLocaleDateString()}</option>)}
        </select>
        {history && history.versions.length < 2 ? <p>没有可回滚的历史版本。</p> : null}
      </label> : null}
      {busy ? <p role="status">正在处理…</p> : null}
      {selected ? <>
        <p>当前 {currentPages} 页 → 所选版本 {selected.pageCount} 页。</p>
        {selected.pageCount < currentPages ? <p role="alert">页数减少：超出新 PDF 页数的批注会保留，但暂时不可见。</p> : null}
        <PdfVersionPreview key={selected.id} scorePath={path} choirId={choirId} scoreId={score.id} versionId={selected.id} onReady={setReady} />
        <label className="confirmation-checkbox"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>我已检查预览，理解排版变化不会迁移批注，批注仍保留原页码和位置。</span></label>
        <Button className="primary-button" isDisabled={!ready || !accepted || busy} onPress={() => void publish()}>{historyOnly ? "确认回滚" : "确认替换"}</Button>
      </> : null}
      {!historyOnly ? <p>确认前原版保持不变。候选文件计入云盘配额，取消后回收，未确认的上传在 24 小时后到期。</p> : null}
      {message ? <p role="alert">{message}</p> : null}
    </Dialog></Modal>
  </ModalOverlay>;
}
