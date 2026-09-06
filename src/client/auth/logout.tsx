import { useRef, useState } from "react";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useNavigate } from "react-router-dom";
import { Dialog } from "../navigation/overlays";
import { authClient } from "./auth-client";
import { clearPrivateLocalDataAfterLogout, getLogoutLocalSummary, type LogoutLocalSummary } from "./logout-local-data";
import { clearPreviewGuestSession } from "./preview-guest-session";
import { clearLibraryDeviceState } from "../score-library/library-view-state";
import { localDatabase } from "../platform/local-database";

export const logoutFenceKey = "auth:explicit-logout";
export function useLogout() {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<LogoutLocalSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const request = async () => {
    try { setSummary(await getLogoutLocalSummary()); setMessage(null); }
    catch { setMessage("无法检查本机待同步内容，请重试。"); }
  };
  const finish = async () => {
    if (running.current) return;
    if (!navigator.onLine) { setMessage("请联网后退出，以确保服务端会话同时失效。"); return; }
    running.current = true; setBusy(true);
    let serverSignedOut = false;
    try {
      const userId = session.data?.user.id;
      if (userId) await localDatabase.system.put({ key: logoutFenceKey, value: JSON.stringify({ userId, sessionId: session.data?.session?.id ?? null, pending: true }) });
      const result = await authClient.signOut();
      if (result.error) throw new Error("sign_out_failed");
      serverSignedOut = true;
      await clearPreviewGuestSession();
      await clearPrivateLocalDataAfterLogout();
      clearLibraryDeviceState();
      const fence = await localDatabase.system.get(logoutFenceKey);
      if (fence) await localDatabase.system.put({ ...fence, value: JSON.stringify({ ...JSON.parse(fence.value), pending: false }) });
      setSummary(null);
      await navigate("/?signedOut=1", { replace: true });
    } catch {
      if (!serverSignedOut) await localDatabase.system.delete(logoutFenceKey).catch(() => undefined);
      setMessage(serverSignedOut ? "服务端已退出，但本机隐私清理未完成。请重试清理。" : "退出未完成，本机数据没有清除。请重试。");
    } finally { running.current = false; setBusy(false); }
  };
  const pending = summary && (summary.pendingOperations || summary.conflicts || summary.syncErrors);
  return { request, dialog: <>
    {message && !summary && <p role="alert">{message}</p>}
    <ModalOverlay className="modal-overlay" isOpen={Boolean(summary)} onOpenChange={open => { if (!open && !busy) setSummary(null); }} isDismissable={!busy}>
      <Modal className="app-modal app-modal--compact"><Dialog className="app-dialog" exitDisabled={busy}>
        <Heading slot="title">确认退出登录</Heading>
        <p>{pending ? `本机还有 ${summary.pendingOperations} 项待同步操作和 ${summary.conflicts} 项本地冲突、${summary.syncErrors} 项同步异常。继续会永久丢弃这些内容。` : "退出后会清除本机个人层、编辑权限和用户偏好；已下载的共享内容可以保留。"}</p>
        {message && <p role="alert">{message}</p>}
        <div className="dialog-actions"><Button className="secondary-button" isDisabled={busy} onPress={() => setSummary(null)}>返回处理</Button><Button className="primary-button" isDisabled={busy} onPress={() => void finish()}>{busy ? "正在退出…" : pending ? "丢弃并退出" : "退出并清除"}</Button></div>
      </Dialog></Modal>
    </ModalOverlay>
  </> };
}
