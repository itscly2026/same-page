# PWA 安装引导调研

核实日期：2026-09-07。范围为官方文档与官方案例；没有进行目标手机实测。以下方案尚未实现。

## 平台事实

- iOS 不应一律要求换 Safari。iOS/iPadOS 16.4 起，第三方浏览器可以提供分享菜单中的添加主屏幕；Chrome 当前官方操作为地址栏旁分享 → 添加到主屏幕 → 添加。[WebKit 16.4](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)、[Chrome iOS 帮助](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&hl=en)
- Safari 当前指引为分享（某些布局先点更多）→ 添加到主屏幕 → 打开“作为网页 App 打开” → 添加。图示不要把分享按钮固定画在底部；不同系统、布局和语言会变化。[Apple iPhone 指南](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- 不应声称所有内置浏览器都无法安装：iOS 17 起 Safari View Controller 也支持添加主屏幕。微信等自定义容器和未核实版本应提供外部浏览器/复制链接兜底，不应假装已精确检测安装能力。此次未找到足够明确的 Edge iOS 当前官方菜单说明，不把第三方浏览器平台能力当成每个版本实现的证明。[WebKit 17.0](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/)
- Android 上可能出现浏览器安装提示，但出现时机由浏览器决定。Chrome 的安装推广有 HTTPS、manifest 和用户参与条件；没有事件不等于不支持安装，也可能尚未满足条件或已安装。[Chrome 安装条件](https://web.dev/articles/install-criteria)
- 支持 `beforeinstallprompt` 的浏览器中，可以保存事件，在用户点击安装按钮时调用 `prompt()`，由浏览器让用户最终确认；每个事件只能用一次。没有事件就不能强行调用系统安装框，应显示手动操作帮助。[自定义安装体验](https://web.dev/articles/customize-install)
- 当前窗口的 `display-mode` 可区分浏览器与应用模式；合谱 manifest 为 `fullscreen`，检测必须覆盖 `fullscreen`、`standalone` 及适用的回退模式，并考虑 iOS `navigator.standalone`。这不是跨浏览器查询设备上是否安装的通用接口。`appinstalled` 在 Android WebAPK 上可能早于实际包安装完成，不应用它承诺图标已经可用。[启动与安装检测](https://web.dev/learn/pwa/detection)
- iOS 17.2 起添加时会复制 cookies，可能保留登录；不会复制其他本地存储，添加后数据也不持续共享。不能保证浏览器里准备好的离线副本自动转入安装后的应用。[WebKit 17.2](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)

官方旧页面也会过时：web.dev 的 [2022 安装提示教程](https://web.dev/learn/pwa/installation-prompt) 仍有“Chrome/Edge iOS 不支持安装，只能 Safari”的旧段落，应以较新的 WebKit 公告与浏览器帮助修正；其事件处理部分仍有参考价值。

## 可借鉴的体验

Google 的官方模式指南建议：先说明价值，入口避开用户主要任务，推广可关闭并记住选择，在用户表现出使用意愿后再建议安装；可以组合页头、菜单和内容区域入口，但控制打扰。[安装推广模式](https://web.dev/articles/promote-install)

官方材料展示了 Spotify 的明确“Install App”按钮；Clipchamp 2020 年团队案例使用工具栏入口与菜单中的提示。可以借鉴其“用户主动找得到”的方式，但这些是历史案例，不代表 2026 年产品当前界面，也不能把案例增长数字归因于单个按钮。[Spotify 示例](https://web.dev/articles/customize-install)、[Clipchamp 团队案例](https://web.dev/case-studies/clipchamp)

## 合谱建议（设计判断）

1. 首页提供明显的“安装合谱”按钮；云盘搜索区域下方可放简短、可关闭的安装卡片，菜单保留长期入口。主文案可用“添加到主屏幕，下次排练一点就能打开”。
2. 主动点击入口始终有反馈：可调用系统框时先显示安装前说明，再由用户点击调用；iOS 优先推荐 Safari，并保留对应分享步骤；未知环境给通用帮助及“没有看到这个选项”的 Safari/Chrome 兜底。设备识别仅用于选择文案，允许手动切换。
3. 自动建议等到首次看谱返回云盘等已完成的使用节点；阅读和写笔记过程中不弹。关闭后本机不反复推荐，但手动入口仍可访问。
4. 将“当前应用模式”“系统安装框已就绪”“需要手动指引”“能力未知”分开；不提供假装可靠的“检查是否安装”按钮，也不将等待超时标成设备不支持。
5. 保持 ADR 0004：安装不构成访问或离线使用门槛。推广不能说“安装后所有乐谱离线可用”；离线副本仍以当前应用环境中完整下载和校验为准。

实施后需用真实 iPhone/iPad Safari 与 Chrome、Android Chrome 和常用内置浏览器验证：入口可找到、步骤准确、拒绝后不打扰、安装后从图标启动、登录/云盘/谱面链路正常，以及安装环境中的离线副本重新准备和断网打开。自动化可以验证分支与事件消费，不能替代系统安装流程实测。

## 本地实现（2026-09-07）

已实现首页首屏入口、登录后的首页入口、云盘菜单入口，以及首次看谱后返回云盘的可关闭建议。关闭建议记在本机；从应用模式启动时隐藏推广。统一安装对话框提供系统安装按钮（事件可用时）、分设备步骤、手动切换和不含邀请码/认证参数的首页网址复制。安装事件一次性消费，取消后保留手动说明。

实现位于 `src/client/install/`。本地截图位于 `artifacts/verification/install/`，包括首页、Safari、iOS Chrome、微信环境、Android、云盘和 320px 窄屏；云盘使用现有视觉测试数据，Android 原生安装能力使用模拟事件。截图不作为真实设备安装成功的证据；尚未部署。

## 微信入口、Safari 优先与 Android 安装前说明补充核实

核实日期：2026-09-07。以下为官方资料支持的事实与据此选择的产品策略；没有执行中国大陆手机网络或微信客户端实测。本节修正上面“可调用系统框时直接调用”的建议：先显示安装前说明，再由用户明确点击按钮调用系统框。

- **Android Chrome 的确可能涉及 Google 安装服务，但不是所有添加主屏幕操作都需要 Play Store。** Chrome 在安装了 GMS 的设备上可使用云端 WebAPK 打包、签名服务；服务不可用时可能回退为网页快捷方式。这支持提示服务/网络风险，不支持“国内网络肯定不能安装”或“用户必须去 Play Store 操作”的绝对文案。没有在本轮核实各中国大陆网络对具体服务端点的可达性。[Google 安装教程](https://web.dev/learn/pwa/installation)
- **安装与运行应区分。** Chromium 文档说明 WebAPK 是调用 Chrome 渲染网页的薄壳；壳更新仍会向 WebAPK 服务发起请求。因此可解释日常打开由浏览器加载合谱，但不能保证“安装后完全不受 Google 服务或网络影响”。文档的安装流程还区分 Play Store 或下载路径。[Chromium WebAPK 架构](https://chromium.googlesource.com/chromium/src/%2B/79eb5783e63721b527d40d3ca16d1455af223617/components/webapps/docs/projects/al-site-settings/webapp_android_architecture.md)
- **iOS Chrome 不使用 Android 的 WebAPK/Play 安装路径。** Google 的 iPhone/iPad 操作是 Chrome 分享 → 添加到主屏幕 → 添加。按产品要求优先引导 Safari 是简化说明的选择，不应把它表述成 Chrome 无法安装。Safari 的实际步骤按 Apple 当前指南展示；不显示 Android Google 服务提醒。[Chrome iOS 帮助](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DiOS&hl=en)、[Apple Safari 指南](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- **桌面快捷方式权限确实存在于部分 Android 系统，应在安装按钮前讲清楚。** 小米官方 REDMI 13C 指南列出“其他权限”中的 Home screen shortcuts，并说明为对应 App 开关权限的路径。它证明这种权限存在，不证明所有 Android、所有 WebAPK 安装都必须预先手动授权。Mozilla QA 也记录过小米设备关闭该权限时无法创建网页快捷方式。对不同机型使用“部分手机需要”“若有该选项，请允许”，将授权对象明确写成用户实际使用的浏览器。[小米权限指南](https://www.mi.com/global/support/faq/details/KA-497759/)、[Mozilla QA 记录](https://bugzilla.mozilla.org/show_bug.cgi?id=1897641)
- **微信采用明确的外部浏览器引导。** 本轮没有找到腾讯官方对所有微信版本 PWA 安装支持的保证或否定；不能把 UA 识别当成系统能力探测。产品可在识别到微信时明确提示“请先在 Safari / 手机浏览器中打开，再安装合谱”，并提供复制网址。普通浏览器中的网页不能保证能强制打开指定外部浏览器；菜单名称按版本变化，保留复制网址后手动粘贴的兜底。
- **Android 可以由按钮调出浏览器安装框，但前提是浏览器已经提供安装事件。** 监听 `beforeinstallprompt` 时调用 `preventDefault()` 保留事件；先展示权限说明，用户点击“打开安装提示”后才调用一次 `prompt()`。无事件时提供手动菜单路径，不能承诺按钮在所有 Android 浏览器都能唤起系统框，也不能保证网站能控制浏览器所有自有安装 UI。[Google 自定义安装体验](https://web.dev/articles/customize-install)

建议使用的产品文案：

> 微信内：请先用 Safari 打开，再安装合谱。点击微信右上角“…”查找在浏览器打开的选项；也可以复制网址，粘贴到 Safari。
>
> Android 安装前：部分手机需要允许浏览器创建桌面快捷方式。在系统设置中找到当前浏览器，查看“权限 / 其他权限”；如有“桌面快捷方式”或“创建桌面快捷方式”，请设为允许，再回来继续。设置名称因手机而异。
>
> Android Chrome：安装可能需要 Google 服务；部分设备或网络环境下可能失败或一直等待。若安装不成功，可尝试浏览器菜单中的“添加到主屏幕 / 创建快捷方式”，也可以继续在网页中使用合谱。

上述文字刻意不承诺安装成功即有离线乐谱；安装后的离线副本和真实系统安装链路仍需分别验证。

本次补充已落地：微信内正常访问不显示转浏览器提醒，也不主动建议安装；只有点击“安装合谱”后，弹窗才显示外部浏览器说明与复制网址；Android 安装前说明位于原生安装按钮之前，只有明确点击才调用事件，微信环境不调用原生安装事件。iOS 不展示 Android 的 Google 服务提示。

Android 最终推荐文案：优先 Chrome 或 Edge，其他浏览器也可尝试；突出 Chrome 安装过程可能需要 Google Play 相关服务、中国境内网络可能失败，以及日常打开合谱无需经过 Play Store。这里不承诺 WebAPK 外壳更新完全不使用 Google 服务。

文案精简：微信弹窗只给转浏览器与复制网址这一步，权限和网络说明留到外部浏览器点击安装时展示；Android 保留浏览器推荐、简短权限说明和 Chrome 安装网络说明，权限设置路径收进帮助，删除重复推荐与步骤。

## 2026-09-08 · #211 更新

本票替换上文“先查看说明、再确认打开安装提示”的交互：已有可调用事件时，入口“安装合谱”直接调用原生窗口，同时提供安装说明；无事件时展示手动步骤。Android 权限文案改为主动检查当前浏览器权限，并补充从桌面图标打开后的结果判断。实现证据与待完成的实体设备验收见 [#211 验证记录](issue-211-invite-install-verification.md)。
