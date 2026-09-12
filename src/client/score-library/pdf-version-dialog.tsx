import { holdUpdate } from "../updates/update-safety";
import { uploadPdf, UPLOAD_TIMEOUT_MS, type UploadProgress } from "./upload-transport";
import { UploadProgressView } from "./upload-progress-view";
import { PurgeDialog } from "../drives/purge-dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button,  Modal, ModalOverlay } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { MAX_PDF_BYTES, scoreVersionHistorySchema, scoreVersionSummarySchema, type ScoreSummary, type ScoreVersionHistory } from "../../shared/scores";
import { authClient } from "../auth/auth-client";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { LibraryDialogHeading } from "./library-dialog-heading";
import { uploadMessage } from "./library-format";
import { PdfVersionPreview } from "./pdf-version-preview";

type Version = ScoreSummary["currentVersion"];
export function PdfVersionDialog({ choirId, score, historyOnly, canPurge = false, onClose, onComplete }: {
  canPurge?: boolean; choirId: string; score: ScoreSummary; historyOnly: boolean;
  onClose(): void; onComplete(message: string): void | Promise<void>;
}) {
  const session = authClient.useSession();
  const [initialUser] = useState(session.data?.user.id);
  const path = `/api/choirs/${choirId}/scores/${score.id}`;
  const [purging, setPurging] = useState(false);
  const [history, setHistory] = useState<ScoreVersionHistory | null>(null);
  const [selected, setSelected] = useState<Version | null>(null);
  const [ready, setReady] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<{ name: string; progress?: UploadProgress } | null>(null);
  const uploading = transfer !== null;
  const [uncertain, setUncertain] = useState(false);
  const uploadController = useRef<AbortController | null>(null);
  const identityValid = useRef(false);
  useLayoutEffect(() => {
    identityValid.current = !session.isPending && !!initialUser && initialUser === session.data?.user.id;
    if (!identityValid.current && uploadController.current) {
      uploadController.current.abort();
      uploadController.current = null;
      setBusy(false); setTransfer(null); setUncertain(true);
      setMessage("上传已中断，结果待核对，请关闭窗口后核对版本信息。");
    }
  }, [initialUser, session.data?.user.id, session.isPending]);
  useLayoutEffect(() => () => {
    uploadController.current?.abort();
    uploadController.current = null;
  }, [path]);
  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);
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
    if (!history || busy || uncertain || uploadController.current || !identityValid.current) return;
    if (!file.size || file.size > MAX_PDF_BYTES) {
      setMessage(file.size ? "PDF 超过 20 MB。" : "PDF 文件为空。");
      return;
    }
    const controller = new AbortController();
    uploadController.current = controller;
    const isCurrent = () => mounted.current && identityValid.current && uploadController.current === controller;
    const releaseUpdate = holdUpdate();
    const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    setBusy(true); setMessage(null); setTransfer({ name: file.name });
    try {
      const form = new FormData(); form.set("file", file); form.set("expectedRevision", String(history.revision));
      const response = await uploadPdf(`${path}/versions`, form, controller.signal, (progress) => {
        if (isCurrent() && !controller.signal.aborted) setTransfer({ name: file.name, progress });
      });
      if (!isCurrent()) return;
      if (!response.ok && [400, 401, 403, 409, 413, 415, 422, 429].includes(response.status)) {
        const payload = await response.json().catch(() => null);
        if (isCurrent()) setMessage(response.status === 401 || response.status === 403
          ? "登录已失效或没有上传权限，请重新登录或联系云盘拥有者。"
          : response.status === 429 ? "请求过于频繁，请稍后再试。" : uploadMessage(response.status, payload));
        return;
      }
      if (!response.ok) throw new Error("unconfirmed_upload");
      const payload = await response.json();
      const version = scoreVersionSummarySchema.parse(payload.version);
      if (!isCurrent()) return;
      candidate.current = version.id;
      setSelected(version); setReady(false); setAccepted(false);
    } catch {
      if (isCurrent()) {
        setUncertain(true);
        setMessage("未能确认候选 PDF 的上传结果，请关闭窗口并核对版本信息，不要直接重传。未确认的候选文件将在 24 小时后到期，当前 PDF 保持不变。");
      }
    } finally {
      window.clearTimeout(timer);
      releaseUpdate();
      if (isCurrent()) { setBusy(false); setTransfer(null); uploadController.current = null; }
    }
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
      await onComplete(historyOnly ? "已回滚 PDF；笔记仍使用原页码和坐标。" : "PDF 已替换；笔记仍使用原页码和坐标。");
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
        <input type="file" accept="application/pdf,.pdf" disabled={!history || busy || uncertain}
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
      {transfer ? <>
        <p role="status">{transfer.progress?.processing ? "传输完成，正在保存…" : "正在上传…"}</p>
        <UploadProgressView name={transfer.name} progress={transfer.progress} />
      </> : busy ? <p role="status">正在处理…</p> : null}
      {selected ? <>
        <p>当前 {currentPages} 页 → 所选版本 {selected.pageCount} 页。</p>
        {selected.pageCount < currentPages ? <p role="alert">页数减少：超出新 PDF 页数的笔记会保留，但暂时不可见。</p> : null}
        <PdfVersionPreview key={selected.id} scorePath={path} choirId={choirId} scoreId={score.id} versionId={selected.id} onReady={setReady} />
        <label className="confirmation-checkbox"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>我已检查预览，理解排版变化不会迁移笔记，笔记仍保留原页码和位置。</span></label>
        <Button className="primary-button" isDisabled={!ready || !accepted || busy} onPress={() => void publish()}>{historyOnly ? "确认回滚" : "确认替换"}</Button>
      </> : null}
      {!historyOnly ? <p>确认前原版保持不变。候选文件计入云盘配额，取消后回收，未确认的上传在 24 小时后到期。</p> : null}
      {historyOnly && selected && canPurge && <Button className="primary-button destructive-button" isDisabled={busy} onPress={() => setPurging(true)}>彻底删除所选历史版本</Button>}
      {purging && selected && <PurgeDialog userId={initialUser} path={`${path}/versions/${selected.id}/purge`} title="彻底删除历史 PDF" description="所选历史谱面将无法查看或回滚。当前 PDF 和笔记不变。" onClose={() => setPurging(false)} onComplete={() => onComplete("历史版本已彻底删除。")} />}
      {message ? <p role="alert">{message}</p> : null}
    </Dialog></Modal>
  </ModalOverlay>;
}
