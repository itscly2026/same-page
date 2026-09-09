# 测试价值审查与清理 · 2026-09-09

初始审查基线：`eeb1b5cd13d217de1040a694eb14c11f017269dd`（#227）；交付已接到 `8aa7d4e`（#228/#229/#230），并补查其新增与修改测试。用户要求对相关测试逐项判断并彻底清理，目标是降低低价值门禁和误报，而非测试数量或覆盖率达标。本次不改变产品行为，不全局加超时、重试或 skip。

## 判断边界

- 保留应用自己的规则：权限、隐私、可靠落盘、幂等、版本/会话隔离、离线可达、迁移和发布身份。
- 保留平台接缝：真实触摸能穿过应用覆盖层滚动、PDF 与批注坐标一致、实际构建的 decoder 和 SW 可用。
- 删除平台内部细节：惯性位移/松手停顿的精确阈值。#227 对照实验有诊断价值，但不自动成为长期门禁。
- 删除装饰实现与重复链路：固定圆角、12px 边距、图文左右顺序、重复 UI 导航及仅自证的合法 schema/标签形状。
- 精确数字不一律删除：笔记坐标、到期/重试期限、权限修订号和触控边界有实际含义；浏览器物理和单次 runner 耗时没有同等确定性。

## 审查方法和范围

清点基线上所有 `*.test.ts/tsx/js/mjs`，核对用例目标、断言模式与运行配置。对删改项读取原测试、相应实现和替代覆盖；对保留项按其独立风险和执行层判断。以下逐文件结论是本基线的覆盖责任清单，不宣称每个保留用例均已做故障注入。另检查原生 renderer、迁移、PWA、加载和发布验证入口。#228/#229/#230 在审查期间合并，其 4 个新增测试文件和既有测试变更已补查：持久化选择、跨标签串行、读取权限未确认时禁止修改、晚到刷新不覆盖草稿、权限表单恢复均保留。其中 #230 的真实认证监听器清理防止 jsdom 销毁后延迟异常，属于测试资源隔离而非重复测试认证库。合并冲突保留新版“我在此云盘”入口及云盘列表返回路径；个人层开关行为继续由 reader-layer-panel 与真实 Worker 保护。

## 删除后的风险去向

| 删除内容 | 留下的保障 |
| --- | --- |
| 惯性必须 >20px、停住后 <=20px、150ms 调度压力及滚动轨迹探针 | 触点按下期间真实 CDP touch 必须使谱面移动；双指输入仍接入应用缩放。惯性手感放到设备验收。手动 reader-touch 工作流只重复新集成场景 |
| shape 按钮圆角、reader 12px/精确中心、首页图文方向 | 控件可达、不遮挡、不溢出、现有触控尺寸和实际操作；不固定排版实现 |
| ui-simplification 的用户设置/阅读器/分享/导出/存储长尾 | user-lifecycle-page、reader-layer-panel、Worker annotations-flow、pdf-export、local-storage-page、真实 storage smoke；权限编辑浏览器接缝保留 |
| reader-status 中用被屏蔽 SW 自造的下载失败 | offline-score-control 的失败/旧版状态，access-smoke 的失败替换及 storage/offline-entry 的真实可用性；保留本机写入失败与同步恢复 |
| 离线失权场景的搜索/排序及多余 goto，管理页后的帮助往返 | drive-library/lifecycle 的视图恢复和 responsive-navigation 的帮助；保留真实失权后找谱与像素证明，去掉会掩盖返回失败的 goto |
| 手拼两份 HTML 比较 pinch preview 与 committed | reader-immersive 中实际阅读器 pinch 前后同时比较 PDF 与批注几何；文字 CSS 的热区/不裁切仍用隔离布局检查 |
| schema 三种合法输入、性能标签词汇快照、modulepreload 标签形状 | Worker preference 实际路由、完整加载脚本真实资源请求；保留领域默认值优先级、中位数报告、预加载取消行为 |
| 加载脚本单次 return <=200ms 与 reopen <=cold | 保留粗粒度 15s 默认预算、测量身份和冷/重开记录；drive-library-lifecycle 挂住响应证明内容先返回，reader-document-cache 证明实际复用 |

首页尺寸矩阵中 WebKit 继续使用移动触摸上下文，验证页面 viewport 遵守设备宽度；合并重复 iPad 启动不丢掉这层接缝。

保留 #229 明确要求的手机首页主入口独占一行、可选入口隐藏后的触控与布局检查；这是本次产品交付的明确行为，不把它等同于无业务理由的装饰间距。

未把所有使用 mock、时间或几何的测试一律删除。PDF canvas 交接、Pencil 激活、失权和超时都需要受控边界；检验这些应用行为和重复验证平台本身是两回事。

## 逐文件判断

初始基线有 121 个自动收集测试文件，#228/#230 新增 4 个，以下共 **125 个测试文件**（每个文件恰好一行）。参数矩阵和子测试不以声明行数冒充运行用例数量。

| 文件 | 决定 | 理由与覆盖责任 |
| --- | --- | --- |
| [browser-tests/access-smoke.test.mjs](../../browser-tests/access-smoke.test.mjs) | 保留 | 真实不可变 PDF 替换、旧离线版在失败时保留、过期回收项不可恢复 |
| [browser-tests/annotations-smoke.test.mjs](../../browser-tests/annotations-smoke.test.mjs) | 保留 | 生产 API/真实 D1 与 IndexedDB 之间的离线和在途笔记保存 |
| [browser-tests/diagnostic-reports.test.mjs](../../browser-tests/diagnostic-reports.test.mjs) | 保留 | 真实页面提交到 Worker 的回执、隐私和受控报告内容 |
| [browser-tests/images-smoke.test.mjs](../../browser-tests/images-smoke.test.mjs) | 保留 | 原生转换到浏览器图片显示及完整离线重开，不以服务端 ready 代替客户端可用 |
| [browser-tests/invite-entry-smoke.test.mjs](../../browser-tests/invite-entry-smoke.test.mjs) | 保留 | 真实邀请自动准入与用户/访客/已加入成员路径 |
| [browser-tests/offline-entry-smoke.test.mjs](../../browser-tests/offline-entry-smoke.test.mjs) | 收敛 | 保留真实成员离线重启/失权本机文件可达；删除失权场景搜索排序及离线返回链中掩盖导航失败的额外 goto |
| [browser-tests/outbox-browser.test.mjs](../../browser-tests/outbox-browser.test.mjs) | 保留 | 原生 IndexedDB 中去重、身份隔离与有界扫描；曾有 WebKit 特定索引风险 |
| [browser-tests/pdf-codecs-smoke.test.mjs](../../browser-tests/pdf-codecs-smoke.test.mjs) | 保留 | 实际打包的 CCITT/JPEG2000 解码器和断源离线渲染；平台库接入故障会导致空白谱 |
| [browser-tests/storage-smoke.test.mjs](../../browser-tests/storage-smoke.test.mjs) | 保留 | 真实 R2 字节经产品下载写入 IndexedDB，停止后端并重启浏览器后谱面仍可见 |
| [scripts/backfill-score-file-names.test.js](../../scripts/backfill-score-file-names.test.js) | 保留 | 历史重名稳定消歧、规范化与重复迁移不改名 |
| [scripts/ci-scope.test.mjs](../../scripts/ci-scope.test.mjs) | 保留 | 未知/删除/改名/跨提交范围 fail-closed，真实 workflow 门禁拒绝异常跳过 |
| [scripts/diagnostic-reports.test.js](../../scripts/diagnostic-reports.test.js) | 保留 | 查询安全、环境明确、保留期和真实迁移 schema |
| [scripts/loading-performance-budget.test.js](../../scripts/loading-performance-budget.test.js) | 保留 | 故意超出应用粗粒度预算会失败；不是测 JS 比较运算本身 |
| [scripts/loading-performance-report.test.js](../../scripts/loading-performance-report.test.js) | 收敛 | 删除三个路径到标签的词汇快照；保留完整样本和中位数报告，避免挑最好结果 |
| [scripts/process-lifecycle.test.js](../../scripts/process-lifecycle.test.js) | 保留 | 释放自有进程及已退出父进程的后代，避免环境污染/端口占用 |
| [scripts/provision-choir.test.js](../../scripts/provision-choir.test.js) | 保留 | 生产准入配置合法、邀请码加密绑定和默认不输出凭据 |
| [scripts/release-admission.test.js](../../scripts/release-admission.test.js) | 保留 | 串行部署不倒退、旧/分叉版本拒绝及文档提交不吞掉待发布产品 |
| [scripts/release-artifact.test.js](../../scripts/release-artifact.test.js) | 保留 | 只能发布原验证字节与对应 SHA，篡改/错版拒绝 |
| [scripts/verify-deployment.test.js](../../scripts/verify-deployment.test.js) | 保留 | 同旧版本不能冒充成功，每个脚本/解码器的身份与缓存验证 |
| [scripts/verify-lifecycle-migration.test.js](../../scripts/verify-lifecycle-migration.test.js) | 保留 | 外键、同步高水位及用户删除后历史保留，防止破坏迁移 |
| [scripts/verify-precache.test.js](../../scripts/verify-precache.test.js) | 保留 | 离线 Worker/解码器不得漏打包，设计源不得进入发布物 |
| [scripts/vite-server.test.js](../../scripts/vite-server.test.js) | 保留 | 自有临时目录、端口、准备取消和失败退出清理 |
| [src/client/annotations/annotation-editor.test.ts](../../src/client/annotations/annotation-editor.test.ts) | 保留 | 连续写入、失败重试、撤销与旧会话隔离，防止丢失最新编辑意图 |
| [src/client/annotations/annotation-overlay.test.tsx](../../src/client/annotations/annotation-overlay.test.tsx) | 保留 | 文字、形状、画笔的实际编辑入口、取消、落盘失败与编辑层隔离；坐标属于笔记数据，不能按装饰像素删除 |
| [src/client/annotations/annotation-refresh.test.ts](../../src/client/annotations/annotation-refresh.test.ts) | 保留 | 失权、共享层变更、跨谱响应与锁/租约隔离，防止旧结果恢复已撤销内容 |
| [src/client/annotations/local-annotations.test.ts](../../src/client/annotations/local-annotations.test.ts) | 保留 | OCC、opId 幂等、未确认写入与重启后的草稿保留 |
| [src/client/annotations/outbox-recovery-coordinator.test.tsx](../../src/client/annotations/outbox-recovery-coordinator.test.tsx) | 保留 | 前台/联网事件合并与用户切换后停止扫描 |
| [src/client/annotations/outbox-recovery.test.ts](../../src/client/annotations/outbox-recovery.test.ts) | 保留 | 不同谱独立恢复、失败隔离、有界扫描与调度公平性 |
| [src/client/annotations/sync.test.ts](../../src/client/annotations/sync.test.ts) | 保留 | 真实本地 outbox 与传输的衔接、丢回执重放及删除顺序；与本地 reducer 测试的接缝不同 |
| [src/client/annotations/use-annotation-editor.test.tsx](../../src/client/annotations/use-annotation-editor.test.tsx) | 保留 | React 生命周期刷新不会丢掉失败编辑或打开的编辑会话 |
| [src/client/app.test.tsx](../../src/client/app.test.tsx) | 保留 | 真实路由组合、认证/邀请入口及组件接线；不机械删除所有与下层状态测试同名的场景 |
| [src/client/auth/auth-client-cleanup.test.ts](../../src/client/auth/auth-client-cleanup.test.ts) | 保留 | #230 新增：真实 session 监听器在环境销毁前卸载，受控时钟检出延迟清理泄漏 |
| [src/client/auth/drive-entry.test.ts](../../src/client/auth/drive-entry.test.ts) | 保留 | 访客、成员和公开体验准入意图，不因登录自动扩大成员关系 |
| [src/client/auth/logout-local-data.test.ts](../../src/client/auth/logout-local-data.test.ts) | 保留 | 用户确认前后草稿清理、跨用户隔离与迟到身份响应 |
| [src/client/auth/offline-entry.test.tsx](../../src/client/auth/offline-entry.test.tsx) | 保留 | 首次断网/会话失效时本机可达性，缓存不成为云端授权 |
| [src/client/auth/preview-guest-session.node.test.ts](../../src/client/auth/preview-guest-session.node.test.ts) | 保留 | 公开体验会话按云盘和退出路径清理 |
| [src/client/auth/session-fetch.node.test.ts](../../src/client/auth/session-fetch.node.test.ts) | 保留 | 旧会话响应不能覆盖新登录身份 |
| [src/client/components/app-header.test.tsx](../../src/client/components/app-header.test.tsx) | 保留 | 通过帮助进入诊断而不刷新丢失内存中的故障记录 |
| [src/client/components/invite-link.node.test.ts](../../src/client/components/invite-link.node.test.ts) | 保留 | 邀请码留在 fragment、异常输入拒绝及往返完整性 |
| [src/client/components/join-code-field.test.tsx](../../src/client/components/join-code-field.test.tsx) | 保留 | 完整输入规范化与单个可访问输入；装饰槽位 aria-hidden 防止重复朗读，不是外观断言 |
| [src/client/components/reload-prompt.test.tsx](../../src/client/components/reload-prompt.test.tsx) | 保留 | 离线/失败重试和已准备版本与运行版本区分 |
| [src/client/components/route-content.test.tsx](../../src/client/components/route-content.test.tsx) | 保留 | 模块加载失败的重试、退出及阅读器加载阶段入口 |
| [src/client/diagnostics/diagnostic-submission.test.ts](../../src/client/diagnostics/diagnostic-submission.test.ts) | 保留 | 用户主动提交、丢回执幂等、隐私与身份代际 |
| [src/client/diagnostics/diagnostics-page.test.tsx](../../src/client/diagnostics/diagnostics-page.test.tsx) | 保留 | 诊断展示/清除、过期、回执及用户切换 |
| [src/client/diagnostics/diagnostics.node.test.ts](../../src/client/diagnostics/diagnostics.node.test.ts) | 保留 | 诊断白名单、HTTP/PDF 错误分类和不泄露异常正文 |
| [src/client/diagnostics/local-operation.test.ts](../../src/client/diagnostics/local-operation.test.ts) | 保留 | 本机异常安全分类、原异常保留及旧身份事件过滤 |
| [src/client/install/install-provider.test.tsx](../../src/client/install/install-provider.test.tsx) | 保留 | 应用对安装事件的一次性消费、取消与手动引导；不测试浏览器安装器内部 |
| [src/client/navigation/navigation.test.tsx](../../src/client/navigation/navigation.test.tsx) | 保留 | 先关闭覆盖层、等待可靠落盘、保留显式目的地和未保存表单 |
| [src/client/offline/offline-lifecycle.test.tsx](../../src/client/offline/offline-lifecycle.test.tsx) | 保留 | Blob 校验、配额回滚、版本/身份竞态、文件清理与快照完整性 |
| [src/client/offline/offline-preparation.test.ts](../../src/client/offline/offline-preparation.test.ts) | 保留 | 共享准备任务、取消与期限、跨谱 Blob 故障隔离；直接覆盖 #221/#223 风险 |
| [src/client/performance/loading-performance.node.test.ts](../../src/client/performance/loading-performance.node.test.ts) | 保留 | 阶段关联与无身份信息的诊断输出 |
| [src/client/platform/local-database.test.ts](../../src/client/platform/local-database.test.ts) | 保留 | 真实 Dexie 版本升级保留文件、快照、草稿、outbox 和冲突 |
| [src/client/platform/local-identity-observer.test.tsx](../../src/client/platform/local-identity-observer.test.tsx) | 保留 | 相同用户重新激活仍需新代际，观察者不能复活旧会话 |
| [src/client/platform/local-workspace.test.ts](../../src/client/platform/local-workspace.test.ts) | 保留 | 升级/切换的原子性、访客与用户隔离和跨标签失效 |
| [src/client/pwa-navigation.node.test.ts](../../src/client/pwa-navigation.node.test.ts) | 保留 | 应用壳导航规则不能把 API 当页面缓存 |
| [src/client/reader/pdf-page.test.tsx](../../src/client/reader/pdf-page.test.tsx) | 保留 | 应用管理双 canvas 的交接，不能清空仍在显示的位图 |
| [src/client/reader/reader-annotation-actions.test.ts](../../src/client/reader/reader-annotation-actions.test.ts) | 保留 | 保存/重试意图可靠落盘和退出后的结果隔离 |
| [src/client/reader/reader-auto-offline.test.ts](../../src/client/reader/reader-auto-offline.test.ts) | 保留 | 自动准备任务跨阅读器生命周期取消与显式下载保留 |
| [src/client/reader/reader-document-cache.test.ts](../../src/client/reader/reader-document-cache.test.ts) | 保留 | 同版本复用、释放、资源上界、失权及错版拒绝；不是 PDF.js 自身单测 |
| [src/client/reader/reader-layer-panel.test.tsx](../../src/client/reader/reader-layer-panel.test.tsx) | 保留 | 分享范围、订阅/编辑隔离、个人层创建幂等与未同步删除保护 |
| [src/client/reader/reader-reopen-tracker.node.test.ts](../../src/client/reader/reader-reopen-tracker.node.test.ts) | 保留 | 冷/暖/重开诊断分类的身份及缓存到期规则 |
| [src/client/reader/reader-runtime.test.ts](../../src/client/reader/reader-runtime.test.ts) | 收敛 | 保留取消后不预加载的调度行为；删除只检查 modulepreload 标签的伪网络证明 |
| [src/client/reader/reader-session.test.ts](../../src/client/reader/reader-session.test.ts) | 保留 | 源码选择、显示确认、期限/取消/重试与旧结果隔离 |
| [src/client/reader/reader-sync-status.node.test.ts](../../src/client/reader/reader-sync-status.node.test.ts) | 保留 | 可靠落盘和服务端确认的区别；状态文案影响数据安全判断，保留 |
| [src/client/reader/use-paged-reader.test.tsx](../../src/client/reader/use-paged-reader.test.tsx) | 保留 | 应用自己的翻页、编辑锁页、边缘输入与取消规则 |
| [src/client/reader/reading-preferences.test.ts](../../src/client/reader/reading-preferences.test.ts) | 保留 | #228 新增：持久化选择、最后意图胜出、旧刷新/跨身份隔离、覆盖继承及无锁时不误发 |
| [src/client/reader/use-reader-gestures.test.tsx](../../src/client/reader/use-reader-gestures.test.tsx) | 收敛 | 保留应用坐标、取消及 redraw 交接；去掉 CSS 自定义属性值和精确测量调用次数 |
| [src/client/reader/use-reader-preferences.test.tsx](../../src/client/reader/use-reader-preferences.test.tsx) | 保留 | 按用户/乐谱记住布局与位置，避免跨身份或版本串用 |
| [src/client/reader/use-tool-color.test.tsx](../../src/client/reader/use-tool-color.test.tsx) | 保留 | 按用户和工具隔离颜色记忆 |
| [src/client/routes/auth-page.test.tsx](../../src/client/routes/auth-page.test.tsx) | 保留 | 登录/注册/恢复的实际 UI 分支、失败和继续目的地 |
| [src/client/routes/drive-management-page.test.tsx](../../src/client/routes/drive-management-page.test.tsx) | 保留 | 成员只读查看与修改权限分离，不提前请求敏感凭据 |
| [src/client/routes/home-entry.test.tsx](../../src/client/routes/home-entry.test.tsx) | 保留 | 首次访问、显式首页意图、成员选择、公开体验及旧身份响应 |
| [src/client/routes/leave-drive-page.test.tsx](../../src/client/routes/leave-drive-page.test.tsx) | 保留 | 退出成员身份与页面返回区分，保留未同步数据并明确确认 |
| [src/client/routes/local-storage-page.test.tsx](../../src/client/routes/local-storage-page.test.tsx) | 保留 | 取消与本机文件清理结果，不能误删云端或草稿 |
| [src/client/routes/membership-management-page.test.tsx](../../src/client/routes/membership-management-page.test.tsx) | 保留 | 权限编辑冲突、保存成功刷新失败、授权范围与双视图草稿 |
| [src/client/routes/reader-page.test.tsx](../../src/client/routes/reader-page.test.tsx) | 保留 | 真实路由接入文档/权限/本地工作区，保留错版、失权、超时、旧响应和离线编辑 |
| [src/client/routes/user-lifecycle-page.test.tsx](../../src/client/routes/user-lifecycle-page.test.tsx) | 保留 | 删除/恢复重新确认、草稿隔离和退出后迟到响应 |
| [src/client/routes/shared-layer-management-page.test.tsx](../../src/client/routes/shared-layer-management-page.test.tsx) | 保留 | #228 新增：暖缓存可看，权限刷新失败仍禁用删除，重试确认后才恢复操作 |
| [src/client/score-library/drive-library-cache.test.ts](../../src/client/score-library/drive-library-cache.test.ts) | 保留 | 缓存按用户隔离、拒绝恢复旧授权及安全诊断 |
| [src/client/score-library/drive-library-transport.test.ts](../../src/client/score-library/drive-library-transport.test.ts) | 保留 | 登录过期与明确失权保持不同语义 |
| [src/client/score-library/drive-library.test.ts](../../src/client/score-library/drive-library.test.ts) | 保留 | 后台刷新与缓存/权限分别建模，返回位置一次恢复和并发响应隔离 |
| [src/client/score-library/drive-settings-dialog.test.tsx](../../src/client/score-library/drive-settings-dialog.test.tsx) | 保留 | 修订冲突保留输入，需要有意识地再次保存 |
| [src/client/score-library/invite-code-dialog.test.tsx](../../src/client/score-library/invite-code-dialog.test.tsx) | 保留 | 原邀请码保留、错配拒绝和读取失败重试 |
| [src/client/score-library/local-library.test.tsx](../../src/client/score-library/local-library.test.tsx) | 保留 | 保留文件入口不构造成员身份，跨用户与失权后的本机可达性 |
| [src/client/score-library/offline-score-control.test.tsx](../../src/client/score-library/offline-score-control.test.tsx) | 保留 | 校验完成才宣称离线可用、旧版保留、跨页面下载与失败重试 |
| [src/client/score-library/pdf-version-dialog.test.tsx](../../src/client/score-library/pdf-version-dialog.test.tsx) | 保留 | 预览及显式接受后才发布，关闭取消与回滚编号 |
| [src/client/score-library/upload-dialog.test.tsx](../../src/client/score-library/upload-dialog.test.tsx) | 保留 | FIFO、失败隔离、未知结果不盲重试、配额和身份切换 |
| [src/client/score-library/use-drive-library.test.tsx](../../src/client/score-library/use-drive-library.test.tsx) | 保留 | React 离开/重新接入时正确处理位置和身份缓存 |
| [src/shared/annotations.test.ts](../../src/shared/annotations.test.ts) | 收敛 | 删除仅接受合法 schema 形状的重复用例；Worker preference 路由保留 false/null/颜色更新，纯函数保留领域优先级 |
| [visual-report/auth-methods.test.mjs](../../visual-report/auth-methods.test.mjs) | 保留 | 真实输入、OTP 失败/继续及两个布局代表，不使用认证库内部实现断言 |
| [visual-report/diagnostics.test.mjs](../../visual-report/diagnostics.test.mjs) | 保留 | 真实 PDF.js 403 与网络错误传到应用诊断；Node 错误 mock 无法替代接缝 |
| [visual-report/drive-library-lifecycle.test.mjs](../../visual-report/drive-library-lifecycle.test.mjs) | 保留 | 挂起后台响应证明缓存返回不等网络、滚动/输入不被刷新覆盖 |
| [visual-report/drive-navigation.test.mjs](../../visual-report/drive-navigation.test.mjs) | 保留 | 浏览器 history、焦点和应用滚动显隐规则；显隐属于应用，保留已隔离场景 |
| [visual-report/drive-settings.test.mjs](../../visual-report/drive-settings.test.mjs) | 收敛 | 保留显示名/改名后的刷新失败与缓存、普通成员能力查看；移除无关帮助到诊断尾段 |
| [visual-report/homepage-responsive.test.mjs](../../visual-report/homepage-responsive.test.mjs) | 收敛 | 保留两引擎最窄宽度、720/721 断点、宽屏及 200% 文字；删除设备商品预设重复和图文左右/上下顺序，保留实际遮挡与溢出 |
| [visual-report/layer-preferences.test.mjs](../../visual-report/layer-preferences.test.mjs) | 保留 | 实际默认值/本谱覆盖、颜色、编辑显示隔离和共享层回收；配套 #225 正在改语义，本基线不混入其实现 |
| [visual-report/pdf-export.test.mjs](../../visual-report/pdf-export.test.mjs) | 合并覆盖 | 接回“取消全部”不改变阅读订阅的独立断言；保留源 PDF 几何与文字/墨迹/透明度保真、订阅范围及失权/离线拒绝 |
| [visual-report/reader-canvas-layering.test.mjs](../../visual-report/reader-canvas-layering.test.mjs) | 保留 | 应用 CSS 可能覆盖 hidden 导致旧 canvas 遮住新画布；elementFromPoint 验证实际遮挡，不只是属性快照 |
| [visual-report/reader-immersive.test.mjs](../../visual-report/reader-immersive.test.mjs) | 收敛 | 删除 2 个精确惯性场景，换 1 个触点按下期间的原生滚动集成检查；保留原生 pinch、错位/编辑锁页与 safe-area；真实批注 pinch 取代手拼 HTML 预览比较；删除圆角断言 |
| [visual-report/reader-mobile-editing.test.mjs](../../visual-report/reader-mobile-editing.test.mjs) | 收敛 | 同一阅读器 resize 取代 7 次重开；保留可达/不重叠/触控区域、编辑和双击回归；删除 12px、中心点对齐和 textarea rows/overflow 实现 |
| [visual-report/reader-status.test.mjs](../../visual-report/reader-status.test.mjs) | 收敛 | 保留真实 IndexedDB 写失败/草稿/同步恢复；删除依赖 mock SW 导致失败的离线下载尾段，改由 offline 控件和真实 storage smoke 覆盖 |
| [visual-report/reader-text-layout.test.mjs](../../visual-report/reader-text-layout.test.mjs) | 收敛 | 保留应用文字 CSS 的真实换行比例/不裁切和点击热区；不规定每行汉字数；删除只比较手拼缩放 HTML 的 pinch 证明 |
| [visual-report/reading-state.test.mjs](../../visual-report/reading-state.test.mjs) | 保留 | #228 新增：真实 DOM/IndexedDB/Web Locks 接缝；挂住响应检查即时选择、双标签串行和暖启动草稿，不依赖精确耗时 |
| [visual-report/responsive-navigation.test.mjs](../../visual-report/responsive-navigation.test.mjs) | 收敛 | 保留真实键盘导航、长文件名、溢出、触控和文件信息；去掉工具栏固定位置、旧帮助入口不存在等排版断言 |
| [visual-report/ui-simplification.test.mjs](../../visual-report/ui-simplification.test.mjs) | 收敛 | 只保留权限编辑/授权分离、受托范围、移除取消及弹窗键盘；移除重复的用户设置、阅读器选项、分享、导出、本机存储和默认成功截图 |
| [visual-report/uiux-return.test.mjs](../../visual-report/uiux-return.test.mjs) | 隔离 | 导航/成员筛选、表单决定、阅读偏好返回、帮助深链各自独立页面；移除品牌 class 断言及成功截图 |
| [visual-report/update-safety.test.mjs](../../visual-report/update-safety.test.mjs) | 保留 | 表单失焦后和提交中仍不能热更新；等待越过应用 3 秒空闲阈值有业务意义，不能按 sleep 一律删除 |
| [visual-report/upload-queue.test.mjs](../../visual-report/upload-queue.test.mjs) | 保留 | 真实文件输入/浏览器丢回执后串行队列和核对入口，组件测试不能替代文件输入集成 |
| [visual-report/ux-refinement.test.mjs](../../visual-report/ux-refinement.test.mjs) | 保留 | 共享层排序刷新后保留及显式保存入口 |
| [visual-report/visual-report.test.mjs](../../visual-report/visual-report.test.mjs) | 保留 | 未知 fixture 请求拒绝外发、报告 HTML 转义；基础设施失误影响隐私/可信证据 |
| [worker/annotations-flow.test.ts](../../worker/annotations-flow.test.ts) | 保留 | 真实 D1 上权限/OCC/幂等/跨谱层生命周期；保留长链路的事务关系与 N+1 增长检查 |
| [worker/auth-flow.test.ts](../../worker/auth-flow.test.ts) | 保留 | 实际配置的 OAuth state、origin、邮箱验证/绑定/密码重置/限流；这些是应用配置的安全边界 |
| [worker/auth/principal.test.ts](../../worker/auth/principal.test.ts) | 保留 | 无 cookie 不加载认证服务、正确消费认证会话与访客优先级 |
| [worker/auth/social-providers.test.ts](../../worker/auth/social-providers.test.ts) | 保留 | 凭据不完整时不能公开启用 provider |
| [worker/diagnostic-reports.test.ts](../../worker/diagnostic-reports.test.ts) | 保留 | 报告隐私、幂等/配额/保留期与失败时不假确认 |
| [worker/diagnostics.test.ts](../../worker/diagnostics.test.ts) | 保留 | 错误日志安全字段和日志失败不得影响请求 |
| [worker/email/send-otp.test.ts](../../worker/email/send-otp.test.ts) | 保留 | 真实邮件服务响应契约；发送未确认时不能误报送达 |
| [worker/images/renderer.test.ts](../../worker/images/renderer.test.ts) | 保留 | 应用自有流式协议长度上限、截断、终止帧与 EOF |
| [worker/index.test.ts](../../worker/index.test.ts) | 保留 | health 发布身份与未知 API 不落到 HTML 壳 |
| [worker/lifecycle-flow.test.ts](../../worker/lifecycle-flow.test.ts) | 保留 | 拥有权唯一性、授权和提交间竞态、用户删除与恢复、草稿服务端边界 |
| [worker/performance/server-timing.test.ts](../../worker/performance/server-timing.test.ts) | 保留 | 应用诊断 header 固定阶段名与计时格式；稳定假时钟，保留低成本契约 |
| [worker/scheduled-cleanup.test.ts](../../worker/scheduled-cleanup.test.ts) | 保留 | 某清理失败不得阻断其他清理 |
| [worker/scores-flow.test.ts](../../worker/scores-flow.test.ts) | 保留 | PDF 上传/版本/回滚/回收/图片准备和独立操作权限 |
| [worker/security/rate-limit-cleanup.test.ts](../../worker/security/rate-limit-cleanup.test.ts) | 保留 | 真实 D1 过期边界、并发续期、批量清理有界及安全日志 |
| [worker/security/security.test.ts](../../worker/security/security.test.ts) | 保留 | 应用邀请码采样无偏及签名访客 token 篡改/过期拒绝 |

## 非自动收集验证入口

| 入口 | 决定与原因 |
| --- | --- |
| renderer/verify.py、renderer/test_transport.py | 保留。实际产物谱面保真、签名/摘要/到期验证和 Linux 解析隔离；属于自有服务接入与部署保证 |
| scripts/verify-score-schema-migration.mjs | 保留。真实历史数据库升级、外键、身份映射、文件及同步高水位；不是仅对 SQL 文本做快照 |
| scripts/verify-pwa-update.mjs | 保留。真实两个构建与 Service Worker 交接，防止草稿/旧页面在更新时损失 |
| scripts/verify-precache.mjs、verify-deployment.mjs、verify-lifecycle-migration.mjs | 保留。产物可离线运行、正确版本发布及迁移安全 |
| scripts/measure-loading-performance.mjs | 收敛。去掉单次精确时间排名和固定 200ms，保留报告、身份、关键请求与粗粒度预算 |
| .github/workflows/browser-stability.yml | 保留可选、有界诊断实验；不默认给每个 PR 跑十遍，不保留已删除的物理断言 |

## 验证记录

- 使用 Node 24 和临时安装的 renderer Python 依赖。初始 #227 基线上，renderer、真实两个构建的 PWA 更新、`npm run check` 全链路及加载测量通过：Node 77、客户端 486、Worker 108、visual 73、smoke 18 项；lint、typecheck、迁移、构建和 precache 通过。
- 首次 `check:full` 在未修改的 offline-entry 首项等待本机文件链接时失败；该文件独跑 9/9、后续完整客户端 486/486 通过。失败时页面仍在加载，尚未证明根因；没有删除该测试或加大超时，不能把重跑通过称为已修复。
- 原生滚动故障注入：临时给真实 `.continuous-reader` 设置 `touch-action: none !important`，精简后的触摸用例明确失败于 `native touch must move the displayed score`（0 未大于 0）。实验结束还出现独立的 macOS 进程清理 `kill EPERM`，不把这个退出错误冒充断言检出。生产 CSS 随后恢复，完整 visual 正向通过。
- 接到 #228/#229 后，lint、typecheck 和受影响的菜单/权限/返回/首页/PDF 导出浏览器测试 26/26 通过。上述全量计数属于最初基线，移动触摸 viewport 补查 2/2 通过；最终包含 #230 的完整客户端用本机 2 workers 运行，58 文件 / 502 项通过，无未捕获异常；完整组合由 PR CI 再验证。未做真实 iPad 手感验收，也不以删减行数宣称已降低 CI 故障率或生产延迟。
