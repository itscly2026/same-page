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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const drives = [...new Map(files?.map(file => [JSON.stringify([file.ownerKey, file.choirId]), { ownerKey: file.ownerKey, choirId: file.choirId }])).values()];
  const clear = async () => {
    if (!selection || busy) return;
    setBusy(true);
    let bytes = 0, failures = 0;
    for (const scope of selection.scopes) {
      try { bytes += await clearLocalFiles(scope); } catch { failures++; }
    }
    setMessage(failures ? `已清理 ${formatBytes(bytes)}；${failures} 项未完成，请重试。` : `已清理 ${formatBytes(bytes)} 本机谱面文件。`);
    setBusy(false); setSelection(null);
  };
  return <div className="app-page"><TaskHeader title={"本机存储"} backTo={`/choirs/${choirId}`} /><main className="page-shell settings-page settings-ux">
    <header className="settings-heading"><p>{files?.[0]?.driveName ?? directory?.choir.name ?? "当前云盘"} · 这台设备</p></header>
    <p>仅清理这台设备已下载的 PDF 和图片谱面，不删除云端文件、个人草稿、待同步操作或冲突，也不退出登录。云盘目录保留，再次打开需联网下载。</p>
    {files === null ? <p role="alert">无法读取本机文件。<Button onPress={() => refresh(value => value + 1)}>重试</Button></p> : files === undefined ? <p role="status">正在统计本机文件…</p> : <>
      {files.length === 0 && <p className="library-empty-state">此云盘尚无本机谱面文件。</p>}
      <p>已下载谱面文件：{formatBytes(files.reduce((sum, file) => sum + file.blob.size, 0))}</p>
      {drives.map(drive => <section key={`${drive.ownerKey}:${drive.choirId}`}>
        <h2>{files.find(file => file.ownerKey === drive.ownerKey && file.choirId === drive.choirId)?.driveName}</h2><Button className="secondary-button" onPress={() => setSelection({ label: "这个云盘的本机谱面文件", scopes: [drive] })}>清理本机文件</Button>
        <ul>{files.filter(file => file.ownerKey === drive.ownerKey && file.choirId === drive.choirId).map(file => <li key={file.key}>
          <Link to={`/choirs/${file.choirId}/scores/${file.scoreId}`}>{scoreDisplayName(file.fileName)}</Link> · {file.imageManifest ? "图片" : "PDF"} · {formatBytes(file.blob.size)} <Button className="text-button" onPress={() => setSelection({ label: file.fileName, scopes: [{ ...drive, scoreId: file.scoreId }] })} aria-label={`移除 ${scoreDisplayName(file.fileName)} 的离线副本`}>移除离线副本</Button>
        </li>)}</ul>
      </section>)}
    </>}
    {message && <p role="status">{message}</p>}
    <ModalOverlay className="modal-overlay" isOpen={Boolean(selection)} onOpenChange={open => { if (!open && !busy) setSelection(null); }} isDismissable={!busy}><Modal className="app-modal"><Dialog className="app-dialog" exitDisabled={busy}>
      <Heading slot="title">清理本机文件</Heading><p>清理{selection?.label}？当前阅读可继续，离线重新打开将不可用。</p>
      <Button className="secondary-button" isDisabled={busy} onPress={() => setSelection(null)}>取消</Button><Button className="primary-button" isDisabled={busy} onPress={() => void clear()}>{busy ? "正在清理…" : "确认清理"}</Button>
    </Dialog></Modal></ModalOverlay>
  </main></div>;
}
