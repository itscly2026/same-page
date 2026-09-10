import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { scorePdfFileName } from "../../shared/score-display-name";
import type { OfflineScoreRecord } from "../platform/local-database";
import { assertLocalWorkspaceActive, LocalWorkspaceOwnerChangedError, type LocalWorkspace } from "../platform/local-workspace";

type Props = { workspace: LocalWorkspace; record: OfflineScoreRecord };

// The caller supplies an already verified offline record; downloading needs no
// PDF engine, network request, or change to local annotation data.
export function LocalPdfDownload({ workspace, record }: Props) {
  const generation = useRef({ value: 0 });
  const pending = useRef(false);
  const urls = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [status, setStatus] = useState<(Props & { busy: boolean; error?: string }) | null>(null);
  useLayoutEffect(() => {
    const ownedUrls = urls.current;
    const lifecycle = generation.current;
    return () => {
      lifecycle.value++;
      pending.current = false;
      for (const [url, timer] of ownedUrls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      ownedUrls.clear();
    };
  }, [workspace, record]);
  const current = status?.workspace === workspace && status.record === record ? status : null;
  const download = async () => {
    if (pending.current) return;
    pending.current = true;
    const attempt = generation.current.value;
    const active = () => attempt === generation.current.value;
    setStatus({ workspace, record, busy: true });
    try {
      if (record.ownerKey !== workspace.ownerKey || record.scopeKey !== workspace.scopeKey ||
          record.choirId !== workspace.choirId || record.scoreId !== workspace.scoreId) {
        throw new LocalWorkspaceOwnerChangedError();
      }
      await assertLocalWorkspaceActive(workspace);
      if (!active()) return;
      const url = URL.createObjectURL(record.blob);
      // Leave the browser time to consume the URL; teardown also releases it.
      urls.current.set(url, setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 60_000));
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = scorePdfFileName(record.fileName);
        document.body.append(link);
        link.click();
      } finally { link.remove(); }
    } catch (error) {
      if (active()) setStatus({ workspace, record, busy: false, error: error instanceof LocalWorkspaceOwnerChangedError
        ? "本机身份或会话已变化，请返回文件库重新打开乐谱后下载。"
        : "下载未完成，请再次点击“下载原 PDF”重试。" });
      return;
    } finally {
      if (active()) pending.current = false;
    }
    if (active()) setStatus({ workspace, record, busy: false });
  };
  return <>
    <Button className="secondary-button" isDisabled={current?.busy} onPress={() => void download()}>下载原 PDF</Button>
    {current?.error && <p role="alert">{current.error}</p>}
  </>;
}
