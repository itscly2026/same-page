# Android 官网安装渠道

合谱在外部 Android 浏览器的“安装合谱”中提供 PWA 和 APK 两种选择。微信等内嵌浏览器只引导外部浏览器，不请求 APK 元数据或显示下载入口。应用模式不主动提示安装。其他平台维持现有安装方式。

## 构建与身份

`android/twa-manifest.json` 管理包名、版本和正式签名公钥指纹。固定 Bubblewrap core 1.25.0 生成工程，使用仓库图标、JDK 17、SDK/build-tools 36、模板的 AGP 8.9.1 / Gradle 8.11.1 / Android Browser Helper 2.6.2。工具升级必须审查生成差异。最低 SDK 23 是包的安装下限，不代表该版本所有浏览器已通过实际排练验收。

```sh
npm ci --prefix android
npm run generate --prefix android
bash android/generated/gradlew -p android/generated --no-daemon assembleRelease
node android/verify.mjs android/generated/app/build/outputs/apk/release/app-release-unsigned.apk --unsigned
```

设置 `JAVA_HOME`、`ANDROID_HOME` 指向本机 JDK/SDK。生成目录不入库；`generate.mjs` 显式收窄 App Links 至 `/choirs/` 和精确 `/install`，排除首页、OAuth/API、下载地址，不手改生成产物。生成和 Gradle 构建必须串行执行。默认 Custom Tabs/browser 回退，无 WebView、通知、原生更新器或安装其他包的权限。

`public/.well-known/assetlinks.json` 绑定正式签名。首次发行前必须先部署网页 PR，由发行任务验证正式域名直达 JSON 和签名关联。模板默认输出工程的 Apache 2.0 授权声明保留；项目源码和发行来源提交可从仓库取得。

## 正式签名与凭据

正式密钥由项目所有者保管，已备份到密码管理器；不进入 Git。GitHub `production` environment 需要：

- `ANDROID_KEYSTORE_BASE64`：密码加密的 PKCS12 文件编码。
- `ANDROID_KEYSTORE_PASSWORD`：相同的 keystore/key 密码；alias 固定 `samepage-release`。
- 现有 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`：token 需能读写发布桶。发行进程按 Cloudflare 官方协议临时派生 S3 凭据，不另存一套访问密钥，不打印 token。

只在受保护的 main 的手动发行任务中注入签名。PR 只构建 unsigned APK。签名后的实际 APK 经过 apksigner、aapt 身份/版本/权限检查；签名凭据在步骤结束清理。

## 单一最新版分发

独立桶 `same-page-android-releases` 仅保存 `android/latest.apk`，不启用公共桶域名，用户经 Worker 下载。版本、摘要和源码 SHA 是该对象的 metadata，同一次 PUT 更新。普通网页 CI 不重新发行 APK。

在 main 执行 GitHub Actions → Android APK → Run workflow：构建并保存 unsigned 产物 → 独立 release job 下载相同产物签名与验证 → 保存 90 天 CI 产物 → 核对正式域名关联 → 条件写入 R2 → 下载复核 SHA-256。发布前必须递增 `appVersionCode`，同步修改语义版本 `appVersion`。相同版本只允许相同摘要的重试；旧版本和同版本不同文件拒绝发布。HEAD 后使用 ETag/If-None-Match 条件 PUT，避免旧作业覆盖新包。

`GET /api/android-release` 返回经过校验的当前元数据，未发布时返回 `release: null`；前端不展示死链接。`GET/HEAD /api/android-release/apk` 只读最新版，正确返回 MIME、下载文件名、ETag 和长度，所有响应 `no-store`。APK 不进入 Service Worker precache，API 导航不走应用外壳回退。

固定对象不提供断点续传：Range/If-Range 请求按 HTTP 允许的完整 `200` 响应处理，`Accept-Ranges: none`；跨版本下载重新开始，避免混合两版字节。后续若引入 Range 必须增加与对象版本绑定的验证，不能直接把请求 Range 转发给可变对象。

## 恢复与验收

R2 不保留历史 APK。CI 发行产物保留 90 天供排查；撤回下载不降级已安装客户端。回退代码也需打更高 versionCode 的修复包；不得要求用户卸载、清站点数据。网页/SW 持续维护与已发行壳的兼容。

安装不是离线校验，也不迁移其他浏览器的本机笔记。下载后回原页面继续；直接从桌面首次打开不承诺恢复下载前邀请。同一浏览器 profile 的网页状态能否延续，以及实际选中的 provider，必须真机记录。

自动验证覆盖安装选择/微信边界、访客跨浏览器 handoff、空发行/元数据/HEAD/更新期间 Range、版本防回退、APK 身份权限与签名。真机需另外验证微信转浏览器、安装来源权限、邮箱和 Google 登录、邀请、平板横竖屏/手写、离线杀进程重开、联网同步、旧壳配新网页和覆盖升级。CI、浏览器仿真与模拟器不能替代真机验收。

来源：[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap/blob/main/packages/cli/README.md)、[R2 token 派生](https://developers.cloudflare.com/r2/api/tokens/)、[R2 一致性与缓存](https://developers.cloudflare.com/r2/reference/consistency/)、[Android 签名](https://developer.android.com/studio/publish/app-signing)。
