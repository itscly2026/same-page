import { AndroidInstallOption } from "./android-install-option";
import { InstallCompletion } from "./install-completion";
import { InstallSteps } from "./install-steps";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Download, X } from "lucide-react";
import { Dialog } from "../navigation/overlays";
import { detectInstallGuide, InstallContext, readInstallPreference, saveInstallPreference } from "./install-context";
import { CopyInstallLink } from "./install-entry";
import "./install.css";

interface InstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

const modes = ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"];
function inAppMode() {
  return modes.some(mode => window.matchMedia?.(`(display-mode: ${mode})`).matches)
    || ("standalone" in navigator && navigator.standalone === true);
}

export function InstallProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const deviceGuide = detectInstallGuide(navigator.userAgent, navigator.maxTouchPoints);
  const ios = deviceGuide === "safari" || deviceGuide.startsWith("ios");
  const [installed, setInstalled] = useState(inAppMode);
  const [runningInApp, setRunningInApp] = useState(inAppMode);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const promptRef = useRef<InstallPromptEvent | null>(null);
  const busyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const guide = deviceGuide;
  const [dismissed, setDismissed] = useState(() => readInstallPreference("install-dismissed"));
  useEffect(() => {
    const ready = (event: Event) => { event.preventDefault(); if (!deviceGuide.endsWith("external")) { promptRef.current = event as InstallPromptEvent; setPrompt(promptRef.current); } };
    const complete = () => { promptRef.current = null; setInstalled(true); setRequested(true); setPrompt(null); };
    const modeChanged = () => { if (inAppMode()) { complete(); setRunningInApp(true); setOpen(false); } };
    const queries = modes.map(mode => window.matchMedia?.(`(display-mode: ${mode})`));
    window.addEventListener("beforeinstallprompt", ready);
    window.addEventListener("appinstalled", complete);
    queries.forEach(query => query?.addEventListener("change", modeChanged));
    return () => {
      window.removeEventListener("beforeinstallprompt", ready);
      window.removeEventListener("appinstalled", complete);
      queries.forEach(query => query?.removeEventListener("change", modeChanged));
    };
  }, [deviceGuide]);
  const dismiss = () => { setDismissed(true); saveInstallPreference("install-dismissed"); };
  const install = async () => {
    const event = promptRef.current;
    if (!event || busyRef.current) return;
    busyRef.current = true;
    promptRef.current = null;
    setBusy(true);
    setPrompt(null); // A browser event can only be consumed once.
    try {
      const result = await event.prompt();
      if (result.outcome === "accepted") { setRequested(true); dismiss(); }
      else { setMessage("已取消安装。你可以继续使用合谱，稍后从菜单查看安装方法。"); dismiss(); }
    } catch { setMessage("暂时无法打开安装窗口，请按下面的步骤添加。"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const show = () => {
    const drive = /^\/choirs\/([^/]+)/.exec(pathname)?.[1];
    if (deviceGuide.endsWith("external") && drive) {
      void navigate(`/install?drive=${encodeURIComponent(drive)}`);
      return;
    }
    setMessage(""); setOpen(true);
    if (!installed && !deviceGuide.endsWith("external") && deviceGuide !== "android") void install();
  };
  const external = guide.endsWith("external");
  const android = deviceGuide.startsWith("android") || guide.startsWith("android");
  return <InstallContext value={{ hidden: installed, runningInApp, requested, nativeAvailable: Boolean(prompt) && !external, suggest: !installed && !dismissed, open: show, dismiss }}>
    {children}
    <ModalOverlay className="modal-overlay" isOpen={open && !runningInApp} onOpenChange={setOpen} isDismissable>
      <Modal className="app-modal install-modal"><Dialog className="app-dialog install-dialog">
        <div className="dialog-heading"><Heading slot="title">{guide === "android" ? "安装合谱" : "添加到主屏幕"}</Heading><Button className="icon-button" aria-label="关闭安装引导" onPress={() => setOpen(false)}><X size={22} /></Button></div>
        <div className="install-intro"><img src="/icon-192.png" width="56" height="56" alt="" /><div><strong>下次排练，一点就能打开</strong><p>添加到主屏幕，随时开始排练。</p></div></div>
        {requested ? <InstallCompletion guide={guide} /> : <>
        {external && <p className="install-platform-note">{ios ? "先用 Safari 打开，再添加到主屏幕。" : "先在浏览器中打开，再添加到主屏幕。"}</p>}
        {prompt && !external ? <Button className="primary-button install-native" isDisabled={busy} onPress={() => void install()}><Download size={18} />添加到主屏幕</Button> : <InstallSteps guide={guide} />}
        {guide === "android" && <AndroidInstallOption />}
        <details className="install-fallback"><summary>{external ? "找不到浏览器选项？" : "添加时遇到问题？"}</summary>
          {ios && <p>没有“添加到主屏幕”？向下滚动分享菜单，或在“编辑操作”中添加；也可以用 Safari 再试。</p>}
          {android && <><p>添加后没有图标？到手机设置中找到当前浏览器 → 权限 / 其他权限，查找“创建桌面快捷方式”并允许；没有此项可跳过。</p><p>仍无法添加，可换浏览器尝试。Chrome 安装可能受 Google Play 服务或网络影响。</p></>}
          {prompt && <InstallSteps guide={guide} />}
          <CopyInstallLink />
        </details>
        {message && <p role="status" className="install-message">{message}</p>}
        <p className="install-note">添加后，回到主屏幕，点合谱图标打开。</p>
        </>}
      </Dialog></Modal>
    </ModalOverlay>
  </InstallContext>;
}
