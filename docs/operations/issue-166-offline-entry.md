# #166 离线入口与身份恢复

## 行为与边界

- 首页和云盘深链接先恢复本机用户与目录；检查中、网络失败、确认无会话分别呈现，不再把 null 一律解释为访客。
- Dexie v10 增加按 owner 隔离的目录，只记录云盘摘要和乐谱元数据。未保存的项目显示“需联网下载”，本机副本进入阅读器后仍须校验。
- 目录写入捕获本机 sessionEpoch，旧响应不能越过 A→B→A；显式退出删除该用户目录。用户切换时旧本机结果不再显示。
- 在线会话恢复为同一用户时保留阅读器实例、阅读偏好和编辑状态；同步仍经过服务端身份和权限检查。
- 认证查询以十秒为上限；登录/退出和较新会话查询使较早响应失效。凭证不会保存到离线目录，Service Worker 不缓存认证响应。

## 自动化

- `src/client/auth/offline-entry.test.tsx`：真实认证客户端与路由，覆盖网络失败、pending、503、401、确认无会话、目录刷新恢复、联网恢复、换用户和显式退出。
- `src/client/auth/session-fetch.test.ts`：认证变更与查询乱序。
- `src/client/score-library/local-library.test.tsx`：用户隔离与 A→B→A 目录写入保护。
- `src/client/routes/reader-page.test.tsx`：已保存副本在认证等待/过期时仍可编辑，同用户恢复后保持编辑状态。
- `browser-tests/offline-entry-smoke.test.mjs`：真实本地 Worker、D1、R2、认证、Service Worker 和 IndexedDB；通过产品下载副本，验证离线首页、云盘、PDF 与联网恢复。Chromium 真实断网并重启浏览器进程；WebKit 关闭并新建页面、注入 API 网络失败以重置 JavaScript 状态，静态资源保持可访问。

运行完整检查：`npm run check`。浏览器证据写入 `artifacts/verification/offline-entry/`。

## 尚需真实设备验收

Playwright WebKit 在当前测试环境跨进程重启和新页面离线导航报内部错误，因此 WebKit 自动化仅覆盖同浏览器进程内新页面的 API 网络失败，不能证明离线应用壳启动。不能据此声称通过了 iOS 已安装 PWA 的强制关闭/重开验收。

iOS 与 Android 需分别在浏览器和已安装 PWA 上验证：登录并保存乐谱，强制关闭，断网重开首页/深链接，编辑并恢复网络，确认草稿同步与阅读位置；另验证会话过期、显式退出和换用户。当前 PR 不部署生产，不将自动化结果视为真实设备验收。

## 本次验证记录

- Chromium：真实断网、关闭并重启浏览器、首页/云盘深链接打开已下载 PDF、恢复网络后保持编辑状态，通过。
- WebKit：完成真实下载后注销测试 Service Worker（否则 Playwright 无法拦截其请求），新页面注入 API 网络失败；本机入口、PDF 与身份恢复，通过。静态资源仍在线。
- 浏览器网络模拟恢复后显式派发 `online` 事件以验证产品事件处理；真实系统联网通知仍属于设备验收。手动“立即同步”会主动重查身份，以覆盖漏收通知的情况。
- 阅读器与身份相关 56 项回归通过；独立 code-review 的 Standards / Spec 阻塞项已修复并复审通过。
