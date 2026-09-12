import { InstallCompletion } from "./install-completion";
import { prepareInstallLink } from "./install-transfer";
import { useLiveQuery } from "dexie-react-hooks";
import { localDatabase } from "../platform/local-database";
import { currentLocalOwnerKey } from "../platform/local-workspace";
import { GUEST_NOTE_LAYER_ID } from "../annotations/guest-notes";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "react-aria-components";
import { guestSessionResponseSchema } from "../../shared/choirs";
import { useApplicationIdentity } from "../auth/application-identity";
import { activateGuestLocalOwner } from "../platform/local-workspace";
import { detectInstallGuide, useInstall } from "./install-context";
import { CopyInstallLink, InstallButton } from "./install-entry";
import { InstallSteps } from "./install-steps";

export default function InstallPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const identity = useApplicationIdentity();
  const install = useInstall();
  const guide = detectInstallGuide(navigator.userAgent, navigator.maxTouchPoints);
  const external = guide.endsWith("external");
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("handoff"));
  const [driveId] = useState(() => new URLSearchParams(location.search).get("drive"));
  const [link, setLink] = useState(token ? window.location.href : "");
  const [destination, setDestination] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const checking = identity.restoring || identity.onlineState === "checking";
  const localUserId = identity.localUserId;
  const hasNotes = useLiveQuery(async () => {
    const owner = await currentLocalOwnerKey();
    if (!external || !owner?.startsWith("guest:")) return false;
    return Boolean(await localDatabase.annotations.where("ownerKey").equals(owner)
      .filter(note => (!driveId || note.choirId === driveId) && note.layerId === GUEST_NOTE_LAYER_ID && !note.deleted).first());
  }, [external, driveId], false);

  useEffect(() => {
    if (checking) return;
    let active = true;
    const controller = new AbortController();
    async function prepare() {
      try {
        if (external) {
          if (token) return;
          if (!driveId) throw new Error("missing");
          const prepared = await prepareInstallLink(driveId, controller.signal);
          if (!active) return;
          if (!prepared) {
            setNeedsLogin(true);
            setLink(new URL(`/install?drive=${encodeURIComponent(driveId)}`, window.location.origin).href);
            return;
          }
          const url = new URL(prepared);
          // WeChat's menu must carry the bridge too, not just Copy.
          await navigate(url.pathname + url.search + url.hash, { replace: true });
          if (active) setLink(prepared);
          return;
        }
        // Remove the bearer fragment before making a request. Keep it only in
        // this mounted component for explicit retries after transient failures.
        if (token) await navigate("/install", { replace: true });
        controller.signal.throwIfAborted();
        const response = token
          ? await fetch("/api/guest/install-handoff/redeem", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })
          : await fetch("/api/guest/session", { cache: "no-store", signal: controller.signal });
        if (!token && driveId && response.status === 401) {
          if (active) { setNeedsLogin(true); setDestination(`/choirs/${encodeURIComponent(driveId)}`); }
          return;
        }
        if (!response.ok) throw new Error(response.status === 401 ? "expired" : "network");
        const guest = guestSessionResponseSchema.parse(await response.json());
        if (!active) return;
        if (!localUserId) await activateGuestLocalOwner(guest.choir.id, controller.signal);
        if (active) setDestination(`/choirs/${guest.choir.id}`);
      } catch (cause) {
        if (active && !controller.signal.aborted) setError(cause instanceof Error && cause.message === "expired" ? "链接已过期或失效，请回原云盘重新点击“添加到主屏幕”。" : "暂时没能接回云盘，请重试。也可以回原云盘继续看谱。");
      }
    }
    void prepare();
    return () => { active = false; controller.abort(); };
  }, [checking, external, token, driveId, localUserId, attempt, navigate]);

  const ready = external ? Boolean(link) : Boolean(destination);
  return <main className="install-page page-shell">
    <Link className="install-brand" to="/" state={{ home: true }}><img src="/icon-192.png" alt="" width="48" height="48" /><span>合谱</span></Link>
    <div className="install-page-card">
      <p className="install-eyebrow">{external ? "第 1 步 · 换到浏览器" : "最后一步 · 添加到主屏幕"}</p>
      <h1>{external ? guide === "ios-external" ? "先用 Safari 打开" : "先在浏览器中打开" : "下次排练，点图标就能打开"}</h1>
      {!ready && !error && <p role="status">正在准备，请稍候…</p>}
      {error && <div role="alert"><p>{error}</p><Button className="secondary-button" onPress={() => { setError(""); setAttempt(value => value + 1); }}>重试</Button></div>}
      {ready && !install?.hidden && !install?.requested && <>
        {external || !install?.nativeAvailable ? <InstallSteps guide={guide} /> : <InstallButton className="primary-button install-native" />}
        {external ? <><p className="install-note">{needsLogin ? "已保留云盘入口。换到浏览器后，可能需要重新登录或使用原邀请。" : "浏览器打开后会接回当前云盘。不用重新找邀请。"}</p><details className="install-fallback"><summary>找不到“在浏览器中打开”？</summary><p>复制链接，粘贴到{guide === "ios-external" ? " Safari " : "浏览器"}打开。</p><CopyInstallLink url={link} /></details>{hasNotes && <p className="install-note">你试写的笔记留在当前 App 里，不会随这次添加转移。</p>}</> : <><p className="install-note">添加后，回到主屏幕，点合谱图标打开这个云盘。</p><details className="install-fallback"><summary>添加时遇到问题？</summary><p>没有看到添加选项？iPhone / iPad 可用 Safari 的分享菜单；Android 可换浏览器尝试。</p><p>Android 添加后没有图标？在系统设置中找到当前浏览器的权限，允许“创建桌面快捷方式”（如有）。Chrome 安装也可能受 Google Play 服务或网络影响。</p></details></>}
      </>}
      {install?.runningInApp ? <p>现在已从合谱应用打开，可以继续看谱。</p> : (install?.requested || install?.hidden) && <InstallCompletion guide={guide} />}
      <Link className="install-skip" to={destination ?? (driveId ? `/choirs/${encodeURIComponent(driveId)}` : "/")} state={{ home: true }}>先看乐谱</Link>
    </div>
  </main>;
}
