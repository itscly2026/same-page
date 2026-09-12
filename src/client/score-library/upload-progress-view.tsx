import { formatBytes } from "./library-format";
import type { UploadProgress } from "./upload-transport";

export function UploadProgressView({ name, progress }: { name: string; progress?: UploadProgress }) {
  return <div className="upload-progress">
    <progress aria-label={`${name} 传输进度`} max={100} value={progress?.percent ?? undefined} />
    {progress && !progress.processing ? <small>
      {progress.percent === null ? "正在传输" : `${Math.floor(progress.percent)}%`} · 平均 {formatBytes(progress.bytesPerSecond)}/s
    </small> : null}
  </div>;
}
