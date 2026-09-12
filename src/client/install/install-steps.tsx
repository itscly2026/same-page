import { Download, Ellipsis, EllipsisVertical, Share, SquarePlus, Compass, Check } from "lucide-react";
import type { InstallGuide } from "./install-context";

// Real control symbols with short labels, rather than screenshots tied to one OS release.
export function InstallSteps({ guide }: { guide: InstallGuide }) {
  const external = guide.endsWith("external");
  const ios = guide === "safari" || guide.startsWith("ios");
  const steps = external ? [
    { icon: Ellipsis, title: "点右上角 ···", detail: "打开当前 App 的菜单。" },
    { icon: Compass, title: ios ? "用 Safari 打开" : "在浏览器中打开", detail: "选择菜单里的“在浏览器中打开”，接着按页面提示添加。" },
  ] : ios ? [
    { icon: Share, title: "点分享按钮", detail: "部分布局需先点“更多”。" },
    { icon: SquarePlus, title: "添加到主屏幕", detail: "在分享菜单中向下找这个选项。" },
    { icon: Check, title: "点“添加”", detail: "如有“作为网页 App 打开”，保持开启。" },
  ] : guide === "android" ? [
    { icon: EllipsisVertical, title: "打开浏览器菜单 ⋮", detail: "通常在右上角或右下角。" },
    { icon: Download, title: "安装应用 / 添加到主屏幕", detail: "选择其中可见的选项，按系统提示确认。" },
  ] : [
    { icon: Download, title: "点击地址栏的安装图标", detail: "Chrome / Edge 也可在浏览器菜单中找到安装选项。" },
    { icon: SquarePlus, title: "Mac Safari：文件 → 添加到程序坞", detail: "确认添加后，从合谱图标打开。" },
  ];
  return <ol className="install-steps">{steps.map(({ icon: Icon, title, detail }, index) => <li key={title}><span aria-hidden="true"><Icon size={23} /></span><div><strong>{index + 1}. {title}</strong><p>{detail}</p></div></li>)}</ol>;
}
