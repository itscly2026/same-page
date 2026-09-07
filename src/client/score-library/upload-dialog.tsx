import { useEffect, useLayoutEffect } from "react";
import { Button,  Modal, ModalOverlay } from "react-aria-components";
import { Dialog } from "../navigation/overlays";

import { LibraryDialogHeading } from "./library-dialog-heading";
import { useUploadQueue } from "./use-upload-queue";

export function UploadDialog({ choirId, isOpen, onOpenChange, onComplete, onQuotaChange, onInspect }: {
  choirId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void | Promise<void>;
  onQuotaChange: (blocked: boolean) => void;
  onInspect: (fileName: string) => void;
}) {
  const queue = useUploadQueue({ choirId, onComplete, onQuotaChange });
  const waiting = queue.items.filter((item) => item.status === "queued").length;
  const uploading = queue.items.some((item) => item.status === "uploading");
  const hasUnfinished = waiting > 0 || uploading;
  const { stopWaiting } = queue;
  useLayoutEffect(() => {
    if (!isOpen) stopWaiting();
  }, [isOpen, stopWaiting]);
  useEffect(() => {
    if (!hasUnfinished) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnfinished]);

  const changeOpen = (open: boolean) => {
    if (!open) queue.stopWaiting();
    onOpenChange(open);
  };

  return <ModalOverlay className="modal-overlay" isOpen={isOpen} onOpenChange={changeOpen} isDismissable>
    <Modal className="app-modal"><Dialog className="app-dialog">
      <LibraryDialogHeading title="上传 PDF" close={() => changeOpen(false)} />
      <p className="dialog-copy">可多选或拖入 PDF，按加入顺序逐个上传。</p>
      <p className="dialog-copy">关闭窗口会停止等待项，正在上传的一份会继续完成。</p>
      <details className="upload-help"><summary>离开页面或上传中断时</summary>
        <p className="dialog-copy">离开此云盘或切换用户会停止本轮上传；已发出的文件可能仍在服务端完成，请返回文件库核对。</p>
      </details>
      <div className="upload-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); queue.add(Array.from(event.dataTransfer.files)); }}>
        <label><span>选择 PDF 文件</span><input type="file" accept="application/pdf,.pdf" multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            queue.add(files);
          }} /></label>
        <small>每份最大 20 MB · 后续选择加入同一队列</small>
      </div>
      <p role="status" aria-live="polite">{uploading ? "正在上传 1 份" : "当前没有上传中的文件"} · 等待 {waiting} 份</p>
      {queue.paused ? <p className="library-message" role="alert">
        {queue.paused === "uncertain" ? "队列已暂停，当前文件结果待核对。可继续其余等待项；核对文件库会关闭窗口并停止等待项。"
          : queue.paused === "quota" ? "队列已暂停，请先释放云盘空间。"
          : queue.paused === "permission" ? "队列已暂停，请先恢复登录或上传权限。" : "队列已暂停，请稍后继续。"}
      </p> : null}
      {queue.refreshFailed ? <p role="alert">文件状态已保留，但列表暂未刷新。请核对文件库，不要重传已完成项。</p> : null}
      {waiting > 0 ? <div className="upload-queue-actions">
        {queue.paused ? <Button className="secondary-button" onPress={queue.resume}>继续等待项</Button> : null}
        <Button className="text-button" onPress={queue.stopWaiting}>停止等待项</Button>
      </div> : null}
      {queue.items.length > 0 ? <ul className="upload-list" aria-label="上传状态">
        {queue.items.map((item) => <li key={item.id} data-status={item.status}>
          <span>{item.name}</span><strong>{item.message}</strong>
          {item.status === "error" && item.file ? <Button className="text-button" aria-label={`重试 ${item.name}`} onPress={() => queue.retry(item.id)}>重试</Button> : null}
          {item.status === "unknown" || item.status === "success" ? <Button className="text-button" aria-label={`核对 ${item.name}`} onPress={() => { changeOpen(false); onInspect(item.name); }}>核对文件库</Button> : null}
        </li>)}
      </ul> : null}
    </Dialog></Modal>
  </ModalOverlay>;
}
