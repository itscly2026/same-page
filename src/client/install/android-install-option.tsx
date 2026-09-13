import { useEffect, useState } from "react";
import { androidReleaseSchema, type AndroidRelease } from "../../shared/android-release";

/** Mounted only in external Android browsers, after the user opens installation. */
export function AndroidInstallOption() {
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/android-release", { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const data: { release?: unknown } = await response.json();
        const parsed = androidReleaseSchema.safeParse(data.release);
        if (!controller.signal.aborted && parsed.success) setRelease(parsed.data);
      }).catch(() => { /* The existing PWA choice remains available offline. */ });
    return () => controller.abort();
  }, []);
  if (!release) return null;
  return <section className="install-apk" aria-label="Android 安装包">
    <a className="secondary-button" href="/api/android-release/apk" download>下载 Android 安装包</a>
    <p className="install-note">版本 {release.versionName} · {(release.size / 1024 / 1024).toFixed(1)} MB</p>
    <p className="install-note">下载后，点浏览器的下载提示安装。安装完成后，回到此页面继续看谱。</p>
    <details className="install-fallback"><summary>安装包使用说明</summary>
      <p>按系统提示允许本次安装。合谱仍需兼容的浏览器运行；安装后不会自动下载乐谱。</p>
      <p>如果打开后需要重新登录，使用原来的登录方式。其他浏览器中的本机笔记和离线乐谱不会自动转移。</p>
    </details>
  </section>;
}
