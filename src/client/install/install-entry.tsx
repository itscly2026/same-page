import { useState } from "react";
import { Button } from "react-aria-components";
import { Download, X } from "lucide-react";
import { useInstall } from "./install-context";

export function InstallButton({ className }: { className?: string }) {
  const install = useInstall();
  if (!install || install.hidden) return null;
  return <Button className={`install-button ${className ?? (install.nativeAvailable ? "primary-button" : "secondary-button")}`} onPress={install.open}><Download size={18} aria-hidden="true" />安装合谱</Button>;
}

export function InstallSuggestion() {
  const install = useInstall();
  if (!install?.suggest) return null;
  return <aside className="install-suggestion" aria-label="安装建议"><img src="/icon-192.png" alt="" width="40" height="40" /><div><strong>把合谱添加到主屏幕</strong><p>下次排练，点一下图标就能打开。</p><InstallButton className="text-button" /></div><Button className="icon-button" aria-label="暂时不用，关闭安装建议" onPress={install.dismiss}><X size={18} /></Button></aside>;
}


export function CopyInstallLink() {
  const [message, setMessage] = useState("");
  // Shared invitations and authentication callbacks must never enter the clipboard.
  const link = `${window.location.origin}/`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setMessage("网址已复制，请粘贴到浏览器打开。"); }
    catch { setMessage("请长按或选中下方网址复制。"); }
  };
  return <div className="install-copy"><Button className="secondary-button" onPress={() => void copy()}>复制合谱网址</Button><input aria-label="合谱网址" readOnly value={link} onFocus={event => event.target.select()} />{message && <p role="status">{message}</p>}</div>;
}
