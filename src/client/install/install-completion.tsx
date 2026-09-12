import type { InstallGuide } from "./install-context";

export function InstallCompletion({ guide }: { guide: InstallGuide }) {
  return <section aria-label="添加后的帮助">
    <p role="status">已提交添加请求，请回到主屏幕，点合谱图标打开。</p>
    <details className="install-fallback">
      <summary>主屏幕没有合谱图标？</summary>
      {guide.startsWith("android") ? <>
        <p>打开手机设置 → 应用 → 当前浏览器 → 权限 / 其他权限，允许“创建桌面快捷方式”（如有）。</p>
        <p>允许后，回到浏览器菜单，再试“添加到主屏幕”或“安装应用”。没有这项权限可跳过。</p>
        <p>仍未出现？可换浏览器尝试。Chrome 安装也可能受 Google Play 服务或网络影响。</p>
      </> : <p>检查是否已在系统窗口点“添加”。也可以回到浏览器，重新按添加步骤操作。</p>}
    </details>
  </section>;
}
