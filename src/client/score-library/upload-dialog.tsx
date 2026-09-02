import { type DragEvent, useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";

import { LibraryDialogHeading } from "./library-dialog-heading";
import { uploadMessage } from "./library-format";

type UploadStatus = "uploading" | "success" | "error";

interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  message: string;
}

export function UploadDialog({
  choirId,
  isOpen,
  onOpenChange,
  onComplete,
  onQuotaBlocked,
}: {
  choirId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void | Promise<void>;
  onQuotaBlocked: () => void;
}) {
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  const startUploads = async (files: File[]) => {
    const nextItems = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: isPdfFile(file) ? ("uploading" as const) : ("error" as const),
      message: isPdfFile(file) ? "正在验证并上传…" : "只接受 PDF 文件。",
    }));
    setUploads((current) => [...nextItems, ...current]);

    const outcomes = await Promise.all(
      nextItems.filter((item) => item.status === "uploading").map(async (item) => {
        const form = new FormData();
        form.set("file", item.file);
        try {
          const response = await fetch(`/api/choirs/${choirId}/scores`, {
            method: "POST",
            body: form,
          });
          const payload = await response.json().catch(() => null);
          const error = (payload as { error?: string } | null)?.error;
          if (error === "storage_quota_exceeded") onQuotaBlocked();
          setUploads((current) =>
            current.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    status: response.ok ? "success" : "error",
                    message: response.ok
                      ? "上传完成"
                      : uploadMessage(response.status, { error }),
                  }
                : entry,
            ),
          );
          return response.ok;
        } catch {
          setUploads((current) =>
            current.map((entry) =>
              entry.id === item.id
                ? { ...entry, status: "error", message: "网络中断，请重新选择该文件。" }
                : entry,
            ),
          );
          return false;
        }
      }),
    );
    if (outcomes.some(Boolean)) await onComplete();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void startUploads(files);
  };

  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
    >
      <Modal className="app-modal">
        <Dialog className="app-dialog">
          {({ close }) => (
            <>
              <LibraryDialogHeading title="上传 PDF" close={close} />
              <p className="dialog-copy">
                可一次选择或拖入多个 PDF。每个文件独立验证，单个失败不影响其他文件。
              </p>
              <div
                className="upload-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
              >
                <label>
                  <span>选择 PDF 文件</span>
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    multiple
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      if (files.length > 0) void startUploads(files);
                    }}
                  />
                </label>
                <small>或拖到这里 · 单份最大 20 MB</small>
              </div>
              {uploads.length > 0 ? (
                <ul className="upload-list" aria-label="上传状态">
                  {uploads.map((item) => (
                    <li key={item.id} data-status={item.status}>
                      <span>{item.file.name}</span>
                      <strong>{item.message}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}
