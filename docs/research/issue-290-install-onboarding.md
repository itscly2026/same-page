# 邀请访客安装流程（#290）

## 交互决策

首次进入云盘直接显示一张可关闭的“添加到主屏幕”卡片。先呈现实际云盘内容，不用注册或安装挡住阅读；关闭后，云盘菜单保留手动入口。安装状态只依据当前应用显示模式及浏览器安装事件，不能因缺少安装事件推断已经安装。

用户点击时若已有 beforeinstallprompt，立即调用系统提示，不先添加确认步骤；系统要求用户手势，不能在页面加载时强制调起。事件只消费一次，取消/拒绝后保留手动说明。内嵌浏览器按设备显示两步图标说明；外部 iOS 浏览器显示分享 → 添加到主屏幕 → 添加。Android 系统快捷方式权限没有可供网页查询的标准接口，不预先要求检查权限；在“添加时遇到问题？”中提供设置、浏览器和网络排查。

微信入口采用独立页面，当前 URL 与“复制链接”均携带同一交接信息，保证微信菜单“在浏览器中打开”也能工作。只在确有本机体验笔记时提醒笔记留在原浏览器，不自动迁移。界面使用产品已有图标风格及真实控制符号，不用与特定系统版本绑定的整屏截图。

## 访问与兼容边界

- POST /api/guest/install-handoff 只从服务端已确认的 guest cookie 签发当前云盘的独立用途 HMAC 凭证；不读取/复制共享邀请码或登录凭证。交接凭证最多十分钟有效，且不能超过源 guest session 寿命。
- 凭证只出现在 URL fragment 与 POST body；兑换前从地址栏移除，并只留在当前组件内供用户重试。交接接口直接使用 fetch，不进入诊断请求记录；服务端响应 no-store。
- 兑换重新检查云盘存在、未清除和 guestSessionVersion，保留原会话到期时间；邀请码轮换即撤销旧交接。重复兑换不会延长源会话，不自动建立成员关系，不覆盖登录 cookie。
- 修改为新增接口/路由，不改 schema、manifest identity、start_url 或现有 API 结构，无数据库/本地存储迁移。旧客户端继续使用原路径；新前端和 Worker 随同一构建发布。旧 Worker 不支持交接时显示可重试失败，不退回泄露邀请码的实现。
- 冷启动优先保持现有成员/本机身份规则。没有用户身份时，仅恢复服务端确认有效的普通访客云盘；不恢复公开体验，不覆盖明确的首页、云盘列表、邀请或乐谱目的地。详见 ADR-0011 补充。

## 平台证据与边界

- [Chrome：安装提示需要用户手势](https://developer.chrome.com/blog/a2hs-updates/)
- [MDN：Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)：未提供浏览器的系统桌面快捷方式权限查询。
- [Apple：iPhone 添加网页 App](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios)
- [WebKit 17.2：添加到主屏幕时复制 cookie](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)；其他网站数据不共享。

自动化通过独立 Chromium context 验证真实 Worker 的访客交接、cookie 与冷启动，UA 模拟只验证页面分支。复制 cookie 的测试是在验证 WebKit 所述契约，不代表真的操作了 iPhone 系统安装。旧版系统、已存在的安装实例、浏览器阻止 cookie 或清除网站数据时，不承诺自动恢复；可从原邀请重新进入。仍需在真实 iPhone 微信 → Safari、Android 微信 → 实际常用浏览器上完成验收，特别是微信菜单文字、国产 Android 快捷方式权限、系统图标创建与桌面启动。

## 本地验证

Node 24.21.0：客户端全量 75 文件 / 643 测试通过，Node 单元 25 文件 / 107 测试通过，凭证单元 4 测试通过，现有 Worker 认证流程 21 测试通过。Chromium/WebKit 首页和导航响应式 7 测试通过。真实 Worker 的安装链路与原邀请入口 smoke 均通过；安装截图位于 artifacts/verification/install-onboarding/。

测试包含：独立微信/Safari 上下文、无本地存储仅带 cookie 的冷启动、安装模式隐藏提示、Android 360px 布局、非授权/错误云盘拒绝签发、邀请码轮换后拒绝兑换。操作系统添加图标与微信原生菜单仍属于真机验收。
