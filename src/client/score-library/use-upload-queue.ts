import { holdUpdate } from "../updates/update-safety";
import { useLayoutEffect, useRef, useState } from "react";

import { MAX_PDF_BYTES, scoreSummarySchema } from "../../shared/scores";
import { uploadPdf, UPLOAD_TIMEOUT_MS, type UploadProgress } from "./upload-transport";
import { uploadMessage } from "./library-format";

type UploadStatus = "queued" | "uploading" | "success" | "error" | "unknown" | "cancelled";
type PauseReason = "permission" | "quota" | "uncertain" | "rate-limit";
export interface UploadItem {
  id: string;
  name: string;
  file: File | null;
  status: UploadStatus;
  message: string;
  progress?: UploadProgress;
}
interface QueueState {
  items: UploadItem[];
  paused: PauseReason | null;
  refreshFailed: boolean;
}
const initialState = (): QueueState => ({ items: [], paused: null, refreshFailed: false });

// The caller keys the dialog by user and drive. One pump owns all batches in
// that lifetime, including while the dialog is hidden. No persisted tasks.
export function useUploadQueue({ choirId, onComplete, onQuotaChange }: {
  choirId: string;
  onComplete: () => void | Promise<void>;
  onQuotaChange: (blocked: boolean) => void;
}) {
  const [state, setState] = useState(initialState);
  const runtime = useRef({ state, active: false, generation: 0, running: false, controller: null as AbortController | null });
  const callbacks = useRef({ onComplete, onQuotaChange });
  useLayoutEffect(() => { callbacks.current = { onComplete, onQuotaChange }; });
  useLayoutEffect(() => {
    const current = runtime.current;
    current.active = true;
    return () => {
      current.active = false;
      current.generation++;
      current.controller?.abort();
      current.running = false;
      // Drop File references on identity changes/navigation, never retain work
      // for another user or a later visit. StrictMode setup can safely repeat.
      current.state = initialState();
    };
  }, []);

  function publish(next: QueueState) {
    runtime.current.state = next;
    if (runtime.current.active) setState(next);
  }

  async function pump() {
    const current = runtime.current;
    if (!current.active || current.running || current.state.paused) return;
    const releaseUpdate = holdUpdate();
    current.running = true;
    const generation = current.generation;
    const isCurrent = () => current.active && generation === current.generation;
    try {
      while (isCurrent() && !current.state.paused) {
        const item = current.state.items.find((entry) => entry.status === "queued");
        if (!item?.file) break;
        publish({ ...current.state, items: current.state.items.map((entry) => entry.id === item.id
          ? { ...entry, status: "uploading", message: "正在上传…", progress: undefined } : entry) });
        const controller = new AbortController();
        current.controller = controller;
        const timer = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        let outcome: UploadOutcome;
        try {
          outcome = await uploadOne(choirId, item.file, controller.signal, (progress) => {
            if (!isCurrent() || controller.signal.aborted) return;
            publish({ ...current.state, items: current.state.items.map((entry) => entry.id === item.id
              ? { ...entry, progress, message: progress.processing ? "传输完成，正在保存…" : "正在上传…" } : entry) });
          });
        } catch {
          outcome = { status: "unknown", message: "网络中断或请求超时，结果待核对。请先查看文件库，不要直接重传。", pause: "uncertain" };
        } finally {
          window.clearTimeout(timer);
        }
        if (!isCurrent()) return;
        current.controller = null;
        publish({ ...current.state, paused: outcome.pause ?? null,
          items: current.state.items.map((entry) => entry.id === item.id ? {
            ...entry, status: outcome.status, message: outcome.message,
            file: outcome.status === "error" ? entry.file : null,
          } : entry),
        });
        if (outcome.pause === "quota" || outcome.status === "success") {
          callbacks.current.onQuotaChange(outcome.pause === "quota");
        }
        // A refresh failure must never enable another POST for a created score.
        try {
          void Promise.resolve(callbacks.current.onComplete()).catch(() => {
            if (isCurrent()) publish({ ...current.state, refreshFailed: true });
          });
        } catch {
          if (isCurrent()) publish({ ...current.state, refreshFailed: true });
        }
      }
    } finally {
      releaseUpdate();
      if (isCurrent()) current.running = false;
    }
  }

  function add(files: File[]) {
    if (!runtime.current.active) return;
    const items = files.map((file): UploadItem => {
      const message = !isPdf(file) ? "只接受 PDF 文件。"
        : file.size === 0 ? "PDF 文件为空。"
        : file.size > MAX_PDF_BYTES ? "PDF 超过 20 MB。" : null;
      return { id: crypto.randomUUID(), name: file.name, file: message ? null : file,
        status: message ? "error" : "queued", message: message ?? "等待上传" };
    });
    publish({ ...runtime.current.state, items: [...runtime.current.state.items, ...items] });
    void pump();
  }

  function retry(id: string) {
    const current = runtime.current.state;
    const item = current.items.find((entry) => entry.id === id);
    if (!item || item.status !== "error" || !item.file) return;
    publish({ ...current, items: [...current.items.filter((entry) => entry.id !== id),
      { ...item, status: "queued", message: current.paused ? "已排队，处理暂停原因后请继续等待项。" : "等待重试" }] });
    void pump();
  }

  function stopWaiting() {
    if (!runtime.current.state.items.some((item) => item.status === "queued")) return;
    publish({ ...runtime.current.state, items: runtime.current.state.items.map((item) => item.status === "queued"
      ? { ...item, status: "cancelled", file: null, message: "已停止，尚未上传；需要时请重新选择。" } : item) });
  }

  function resume() {
    publish({ ...runtime.current.state, paused: null });
    void pump();
  }

  return { ...state, add, retry, stopWaiting, resume };
}

interface UploadOutcome {
  status: "success" | "error" | "unknown";
  message: string;
  pause?: PauseReason;
}

async function uploadOne(choirId: string, file: File, signal: AbortSignal, onProgress: (progress: UploadProgress) => void): Promise<UploadOutcome> {
  const form = new FormData();
  form.set("file", file);
  const response = await uploadPdf(`/api/choirs/${choirId}/scores`, form, signal, onProgress);
  const payload: unknown = await response.json().catch(() => null);
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : null;
  if (response.ok) {
    const score = scoreSummarySchema.safeParse(payload && typeof payload === "object" && "score" in payload ? payload.score : null);
    if (score.success && score.data.choirId === choirId && score.data.fileName === file.name.trim()) {
      return { status: "success", message: "上传完成" };
    }
  } else if (response.status === 401 || response.status === 403) {
    return { status: "error", message: "登录已失效或没有上传权限，请重新登录或联系云盘拥有者。", pause: "permission" };
  } else if ((error === "storage_quota_exceeded" || error === "score_limit_reached" || error === "platform_storage_limit_reached") && response.status === 409) {
    return { status: "error", message: uploadMessage(response.status, payload), pause: "quota" };
  } else if (response.status === 429) {
    return { status: "error", message: "请求过于频繁，请稍后再重试。", pause: "rate-limit" };
  } else if ([400, 409, 413, 415, 422].includes(response.status)) {
    return { status: "error", message: uploadMessage(response.status, payload) };
  }
  return { status: "unknown", message: "服务端未确认上传结果。请先核对文件库，此项不能直接重试。", pause: "uncertain" };
}

function isPdf(file: File) {
  return file.type === "application/pdf" || (!file.type && file.name.toLowerCase().endsWith(".pdf"));
}
