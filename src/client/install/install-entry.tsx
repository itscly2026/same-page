import { prepareInstallLink } from "./install-transfer";
import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { Download, X } from "lucide-react";
import { useInstall } from "./install-context";

export function InstallButton({ className }: { className?: string }) {
  const install = useInstall();
  if (!install || install.hidden) return null;
  return <Button className={`install-button ${className ?? (install.nativeAvailable ? "primary-button" : "secondary-button")}`} onPress={install.open}><Download size={18} aria-hidden="true" />添加到主屏幕</Button>;
}

export function InstallSuggestion() {
  const install = useInstall();
  if (!install?.suggest) return null;
  return <aside className="install-suggestion" aria-label="安装建议"><img src="/icon-192.png" alt="" width="40" height="40" /><div><strong>把合谱添加到主屏幕</strong><p>下次排练，点一下图标就能打开。</p><InstallButton className="primary-button" /></div><Button className="icon-button" aria-label="暂时不用，关闭安装建议" onPress={install.dismiss}><X size={18} /></Button></aside>;
}


export function CopyInstallLink({ url }: { url?: string } = {}) {
  const [message, setMessage] = useState("");
  const drive = /^\/choirs\/([^/]+)/.exec(window.location.pathname)?.[1];
  const [prepared, setPrepared] = useState<{ drive: string; url: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const link = url ?? (prepared?.drive === drive ? prepared?.url : null) ?? (drive ? "" : `${window.location.origin}/`);
  useEffect(() => {
    if (url || !drive) return;
    const controller = new AbortController();
    void prepareInstallLink(drive, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setPrepared({ drive, url: value ?? new URL(`/choirs/${encodeURIComponent(drive)}`, window.location.origin).href });
      if (!value) setMessage("已保留云盘入口；换浏览器后可能需要重新登录或使用原邀请。");
    }).catch(() => { if (!controller.signal.aborted) setMessage("暂时无法准备链接，请重试。"); });
    return () => controller.abort();
  }, [url, drive, attempt]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setMessage("网址已复制，请粘贴到浏览器打开。"); }
    catch { setMessage("请长按或选中下方网址复制。"); }
  };
  if (!link) return <div className="install-copy"><p role="status">{message || "正在准备云盘链接…"}</p>{message && <Button onPress={() => { setMessage(""); setAttempt(value => value + 1); }}>重试</Button>}</div>;
  return <div className="install-copy"><Button className="secondary-button" onPress={() => void copy()}>复制链接</Button><input aria-label="合谱网址" readOnly value={link} onFocus={event => event.target.select()} />{message && <p role="status">{message}</p>}</div>;
}
