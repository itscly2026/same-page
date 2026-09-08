import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Button, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Download, Share, X } from "lucide-react";
import { Dialog } from "../navigation/overlays";
import { detectInstallGuide, isWeChat, InstallContext, readInstallPreference, saveInstallPreference, type InstallGuide } from "./install-context";
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

const guides: Record<InstallGuide, { title: string; steps: string[] }> = {
  safari: { title: "iPhone / iPad · Safari（推荐）", steps: ["点击分享按钮（部分布局需先点“更多”）。", "选择“添加到主屏幕”。如果没看到，向下滚动或在“编辑操作”中添加。", "开启“作为网页 App 打开”（如有），再点“添加”。"] },
  "ios-chrome": { title: "iPhone / iPad · Chrome", steps: ["点击地址栏旁的分享按钮。", "选择“添加到主屏幕”。", "确认名称为“合谱”，点击“添加”。"] },
  "ios-external": { title: "iPhone / iPad · App 内打开", steps: ["打开当前 App 的菜单，寻找“在浏览器中打开”；选择 Safari。", "也可以复制下方网址，粘贴到 Safari 打开。", "在 Safari 中点击分享 → 添加到主屏幕 → 添加。"] },
  android: { title: "Android 手机 / 平板", steps: ["打开浏览器菜单（通常是右上角 ⋮）。", "选择“安装应用”或“添加到主屏幕”，按提示确认。"] },
  "android-external": { title: "Android · App 内打开", steps: ["打开当前 App 的菜单，选择“在浏览器中打开”。", "也可以复制下方网址，用 Chrome 或 Edge 打开；其他浏览器也可以尝试。", "在浏览器中再次点击“安装合谱”，按提示完成安装。"] },
  desktop: { title: "电脑", steps: ["在 Chrome 或 Edge 中，点击地址栏的安装图标，或在浏览器菜单中寻找安装选项。", "Mac 的 Safari 可从“文件”菜单选择“添加到程序坞”（支持此功能的系统版本）。", "确认添加后，从应用图标打开合谱。"] },
};

export function InstallProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const wechat = isWeChat(navigator.userAgent);
  const deviceGuide = detectInstallGuide(navigator.userAgent, navigator.maxTouchPoints);
  const ios = deviceGuide === "safari" || deviceGuide.startsWith("ios");
  const [installed, setInstalled] = useState(inAppMode);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const promptRef = useRef<InstallPromptEvent | null>(null);
  const busyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [guide, setGuide] = useState(() => detectInstallGuide(navigator.userAgent, navigator.maxTouchPoints));
  const [dismissed, setDismissed] = useState(() => readInstallPreference("install-dismissed"));
  useEffect(() => {
    if (/\/scores\/[^/]+$/.test(pathname)) saveInstallPreference("install-seen-score");
  }, [pathname]);
  useEffect(() => {
    const ready = (event: Event) => { event.preventDefault(); if (!wechat) { promptRef.current = event as InstallPromptEvent; setPrompt(promptRef.current); } };
    const complete = () => { promptRef.current = null; setInstalled(true); setPrompt(null); setOpen(false); };
    const modeChanged = () => { if (inAppMode()) complete(); };
    const queries = modes.map(mode => window.matchMedia?.(`(display-mode: ${mode})`));
    window.addEventListener("beforeinstallprompt", ready);
    window.addEventListener("appinstalled", complete);
    queries.forEach(query => query?.addEventListener("change", modeChanged));
    return () => {
      window.removeEventListener("beforeinstallprompt", ready);
      window.removeEventListener("appinstalled", complete);
      queries.forEach(query => query?.removeEventListener("change", modeChanged));
    };
  }, [wechat]);
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
      if (result.outcome === "accepted") { setOpen(false); dismiss(); }
      else { setMessage("已取消安装。你可以继续使用合谱，稍后从菜单查看安装方法。"); dismiss(); }
    } catch { setMessage("暂时无法打开安装窗口，请按下面的步骤添加。"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const show = () => { setMessage(""); setOpen(true); if (!installed && !wechat) void install(); };
  const external = guide.endsWith("external");
  const android = deviceGuide.startsWith("android") || guide.startsWith("android");
  const steps = <ol className="install-steps">{guides[guide].steps.map((step, index) => <li key={step}><span>{index === 0 && (guide === "safari" || guide === "ios-chrome") ? <Share size={19} /> : index + 1}</span><p>{step}</p></li>)}</ol>;
  return <InstallContext value={{ hidden: installed, nativeAvailable: Boolean(prompt) && !wechat, suggest: !wechat && !installed && !dismissed && readInstallPreference("install-seen-score"), open: show, dismiss }}>
    {children}
    <ModalOverlay className="modal-overlay" isOpen={open && !installed} onOpenChange={setOpen} isDismissable>
      <Modal className="app-modal install-modal"><Dialog className="app-dialog install-dialog">
        <div className="dialog-heading"><Heading slot="title">安装合谱</Heading><Button className="icon-button" aria-label="关闭安装引导" onPress={() => setOpen(false)}><X size={22} /></Button></div>
        <div className="install-intro"><img src="/icon-192.png" width="56" height="56" alt="" /><div><strong>下次排练，一点就能打开</strong><p>添加到主屏幕，随时开始排练。</p></div></div>
        {wechat && <section className="install-advice"><strong>{ios ? "请先用 Safari 打开" : "请先在外部浏览器中打开"}</strong><p>{!ios && "推荐 Chrome 或 Edge，其他浏览器也可尝试。"}{deviceGuide === "desktop" ? "打开微信菜单" : "点击右上角“···”"}，选择“{ios ? "在 Safari 中打开（或在浏览器中打开）" : "在浏览器中打开"}”。也可复制网址，在浏览器打开后再点“安装合谱”。</p><CopyInstallLink /></section>}
        {ios && !wechat && <p className="install-platform-note">推荐用 <strong>Safari</strong> 添加到主屏幕。</p>}
        {!wechat && <>
        <label className="install-selector">查看安装方法<select value={guide} onChange={event => setGuide(event.target.value as InstallGuide)}>{Object.entries(guides).map(([key, value]) => <option key={key} value={key}>{value.title}</option>)}</select></label>
        {android && <p className="install-platform-note">Android 推荐使用 <strong>Chrome 或 Edge</strong>，其他浏览器也可以尝试。</p>}
        {android && <section className="install-advice" aria-label="Android 安装前说明"><strong>桌面快捷方式权限</strong><p>安装前，请检查当前浏览器是否已获准创建桌面快捷方式；手机提供此权限项时，请确保已开启。</p><p>在手机设置 → 应用 → 当前浏览器 → 权限 / 其他权限中查找“创建桌面快捷方式”。名称和位置因机型而异，没有此项可跳过；网页无法读取或授予这项系统权限。</p><p className="install-network-note">Chrome 的<strong>安装过程</strong>可能需要 Google Play 服务，中国境内网络可能导致失败；日常打开合谱无需经过 Play Store。</p></section>}
        {prompt && <Button className="primary-button install-native" isDisabled={busy} onPress={() => void install()}><Download size={18} />安装合谱</Button>}
        {prompt ? <details className="install-fallback"><summary>也可以手动添加</summary>{steps}</details> : steps}
        <details className="install-fallback" open={external}><summary>{external ? "复制网址，用浏览器打开" : "没有看到这个选项？"}</summary><p>可切换上方的安装方法，或复制网址换浏览器尝试。</p>{android && <p>添加后没有图标？在手机设置中找到当前浏览器的“权限 / 其他权限”，允许创建桌面快捷方式。名称因机型而异。</p>}<CopyInstallLink /></details>
        </>}
        {message && <p role="status" className="install-message">{message}</p>}
        <p className="install-note">安装后，请从桌面合谱图标打开。正常应以独立应用窗口显示；若仍显示普通浏览器地址栏，可能只添加了网页快捷方式，可换浏览器重新安装。这适用于合谱正常应用范围内的页面，外部链接打开浏览器不算安装失败。</p>
        {!wechat && <p className="install-note">断网前，请确认所需乐谱的离线副本已就绪。</p>}
      </Dialog></Modal>
    </ModalOverlay>
  </InstallContext>;
}
