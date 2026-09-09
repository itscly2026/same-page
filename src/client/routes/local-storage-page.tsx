import { createLocalWorkspace } from "../platform/local-workspace";
import { useOfflineScore } from "../offline/use-offline-score";
import { useApplicationIdentity } from "../auth/application-identity";
import { localDatabase } from "../platform/local-database";
import { scoreDisplayName } from "../../shared/score-display-name";
import { Link, useParams } from "react-router-dom";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import { TaskHeader } from "../components/task-header";
import { Dialog } from "../navigation/overlays";
import { clearLocalFiles, listLocalFiles, type LocalFileScope } from "../offline/local-files";
import { formatBytes } from "../score-library/library-format";

export default function LocalStoragePage() {
  const { choirId = "" } = useParams();
  const identity = useApplicationIdentity();
  const directory = useLiveQuery(() => identity.localUserId ? localDatabase.driveDirectories.where("[ownerKey+choirId]").equals([`user:${identity.localUserId}`, choirId]).first() : undefined, [identity.localUserId, choirId]);
  const [revision, refresh] = useState(0);
  const files = useLiveQuery(() => listLocalFiles().then(files => files.filter(file => file.choirId === choirId)).catch(() => null), [revision, choirId]);
  const [selection, setSelection] = useState<{ label: string; scopes: LocalFileScope[] } | null>(null);
  const [retrySelection, setRetrySelection] = useState<typeof selection>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const totalBytes = files?.reduce((sum, file) => sum + file.blob.size, 0) ?? 0;
  const scopes = [...new Map(files?.map(file => [JSON.stringify([file.ownerKey, file.choirId, file.scoreId]), { ownerKey: file.ownerKey, choirId: file.choirId, scoreId: file.scoreId }])).values()];
  const clear = async () => {
    if (!selection || busy) return;
    setBusy(true);
    let bytes = 0;
    const failures: LocalFileScope[] = [];
    for (const scope of selection.scopes) {
      try { bytes += await clearLocalFiles(scope); } catch { failures.push(scope); }
    }
    setRetrySelection(failures.length ? { label: "上次未完成清理的谱面", scopes: failures } : null);
    setMessage(failures.length ? `已清理 ${formatBytes(bytes)}；${failures.length} 项未完成，请重试。` : `已清理 ${formatBytes(bytes)} 本机谱面文件。`);
    setBusy(false); setSelection(null);
  };
  return <div className="app-page"><TaskHeader title={"本机存储"} backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page settings-ux">
    <header className="settings-heading"><p>{files?.[0]?.driveName ?? directory?.choir.name ?? "当前云盘"} · 这台设备</p></header>
    <p>清理仅移除这台设备上的谱面，云端乐谱和笔记保留。</p>
    {files === null ? <p role="alert">无法读取本机文件。<Button onPress={() => refresh(value => value + 1)}>重试</Button></p> : files === undefined ? <p role="status">正在统计本机文件…</p> : <>
      {files.length === 0 && <p className="library-empty-state">此云盘尚无本机谱面文件。</p>}
      <p className="local-storage-summary">{formatBytes(totalBytes)} <small>· {new Set(files.map(file => file.scoreId)).size} 份乐谱</small></p>
      {files.length > 0 && <Button className="secondary-button" onPress={() => setSelection({ label: "本云盘的全部本机谱面文件", scopes })}>清理全部 · 可释放 {formatBytes(totalBytes)}</Button>}
      <ul className="local-file-list">{files.map(file => <LocalFileRow key={file.key} file={file} currentVersionId={directory?.scores.find(score => score.id === file.scoreId)?.currentVersion.id} onClear={() => setSelection({ label: file.fileName, scopes: [{ ownerKey: file.ownerKey, choirId: file.choirId, scoreId: file.scoreId }] })} />)}</ul>
    </>}
    {message && <p role="status">{message}</p>}{retrySelection && <Button className="secondary-button" onPress={() => setSelection(retrySelection)}>重试未完成清理</Button>}
    <ModalOverlay className="modal-overlay" isOpen={Boolean(selection)} onOpenChange={open => { if (!open && !busy) setSelection(null); }} isDismissable={!busy}><Modal className="app-modal"><Dialog className="app-dialog" exitDisabled={busy}>
      <Heading slot="title">清理本机文件</Heading><p>只清理已下载的 PDF 和图片。云端文件、云盘目录、个人草稿、待同步操作和冲突均保留，也不退出登录。</p><p>清理{selection?.label}？当前阅读可继续，离线重新打开将不可用。</p>
      <Button className="secondary-button" isDisabled={busy} onPress={() => setSelection(null)}>取消</Button><Button className="primary-button" isDisabled={busy} onPress={() => void clear()}>{busy ? "正在清理…" : "确认清理"}</Button>
    </Dialog></Modal></ModalOverlay>
  </main></div>;
}

function LocalFileRow({ file, currentVersionId, onClear }: { currentVersionId?: string; file: Awaited<ReturnType<typeof listLocalFiles>>[number]; onClear(): void }) {
  const workspace = createLocalWorkspace(file.ownerKey, file.choirId, file.scoreId);
  const offline = useOfflineScore(workspace);
  const status = !offline ? "正在校验…" : offline.readFailed ? "校验失败，请重新打开重试" : offline.record?.key === file.key ? currentVersionId && file.versionId !== currentVersionId ? "需更新 · 已保存旧版" : "可离线" : "副本不可用，需重新下载";
  return <li className="local-file-row"><div><Link to={`/choirs/${file.choirId}/scores/${file.scoreId}`}>{scoreDisplayName(file.fileName)}</Link>
    <p>{formatBytes(file.blob.size)} · {status}</p></div>
    <Button className="text-button" onPress={onClear} aria-label={`移除 ${scoreDisplayName(file.fileName)} 的离线副本`}>清理</Button></li>;
}
