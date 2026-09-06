# 测试深度清理 #174

实施基线：`fc0717b28a2e95d111dd2a55e98bfc344ee1a469`，独立 worktree。产品代码、迁移文件、发布产物封存和 renderer 部署协议均未修改。

## 风险去向

| 原覆盖 / 成本 | 处理与理由 | 保留位置 |
| --- | --- | --- |
| layer-preferences 每个宽度重复导航偏好、颜色、reader、管理页 | 每个页面/弹层只打开一次，依次改变原有视口；等待 ResizeObserver 完成后测量。两个引擎仍各执行完整失败/重试、颜色恢复、订阅与编辑隔离 | 原文件；原视口集合与 44px/越界断言保留 |
| reader-status 两宽度完整保存失败、草稿、同步恢复 | 390 完整执行一次，每个原截图状态都原地检查 390/834 的无溢出与弹窗裁切 | 原文件；保留未完成编辑、QuotaExceededError、零离线 push、同步失败/恢复、下载失败和显示回滚 |
| homepage 强制 flex/grid | 删除 CSS 机制断言；保留原宽度、两个 WebKit iPad 预设、200% 文字，以及实际文字/插图阅读顺序、内容裁切 | homepage-responsive |
| drive-navigation 834/1440 空搜索结果无溢出 | 保留独有 320 极窄空结果；公共 390/834/1194/1440 长文件名、搜索/清空/排序、44px 矩阵由 drive-entry-library 负责 | drive-navigation 保留菜单焦点恢复、滚动上传入口、键盘和空结果交互；drive-entry-library 两引擎完整保留 |
| auth-methods / reader-status 成功截图 | 默认不写截图；`LAYOUT_CAPTURE_DIR=1` 显式报告模式保留原 artifacts 路径。截图没有差异判定，行为/几何仍每次断言 | 原文件；reader-status 新增每个状态的尺寸测量 |
| 所有客户端文件加载 React、IndexedDB 和数据库删除 | DOM 无存储清单只加载 DOM cleanup；数据库逻辑只加载 fake IndexedDB + 每用例删除；其余 DOM/数据库测试保持两者。未审计的新文件默认带数据库隔离 | vitest.client.config.ts、src/test/setup{,-database}.ts |
| invite-link、session-fetch、loading-performance | 3 文件/6 项迁到 Node，无产品兼容代码、断言删除或 mock 增加 | 同目录 *.node.test.ts；原生 URL/Response/性能记录接口 |
| 每个迁移文件启动 Wrangler | 同一 applyMigrations 调用内合并 SQL 文件，保留顺序和 PRAGMA；原数据插入/观测点不移动 | verify-score-schema-migration；真实 D1、旧记录、外键、文件名 backfill 幂等检查全部保留 |
| storage/offline-entry 仅 canvas 可见 | 增加 PDF 本身的深色谱面与浅色底色像素证明，不计批注或 UI 像素；透明、全白、全黑均不通过 | browser-tests/pdf-content.mjs；访客离线进程重启、成员重启、WebKit API 故障仍分别执行 |

没有按数量删除测试；Node 与客户端合计仍 437 项。没有新增 skip/todo、重试或加宽超时。其余身份、个人层、OCC/outbox、真实 D1/R2、codec、图片离线、PWA、发布门禁测试保留。

## 模块与 CI 选择

精确审计的展示模块只有 `drive-settings-dialog.tsx`、`drive-header.tsx`、`upload-fab.tsx`；它们的产品消费者为 `routes/choir-page.tsx`。不是按目录名将整个 score-library 判为低风险：该目录内的缓存、useDriveLibrary、下载、上传和 reader 来源选择仍走全部组。只有这些展示模块（可混合文档）变更才选择 library：

- visual：drive-settings、drive-navigation、drive-entry-library、drive-library-lifecycle、upload-queue、responsive-navigation、ux-refinement。
- smoke：storage-smoke、offline-entry-smoke，保留真实访客/成员的入口与离线存储消费者。
- client/build/deploy 保留，performance 不选；renderer/codec 的独立浏览器流程不选。

混合任何其他产品路径、共享样式、reader、认证、离线、依赖、公共基础设施或未知路径，都回到 all 浏览器组。认证、offline、platform 与 app 的改动另外明确选择 PWA 交接。缺少历史仍全部验证。选择器自身变更也选择完整验证。新增消费者或改变这些模块职责时必须重新审计本清单。

`scripts/run-browser-tests.mjs` 对未知 suite/group、空集合报错；all 从目录枚举所有用例，新浏览器文件不会漏掉。required verify 测试直接执行 workflow 内的真实门禁脚本，覆盖选中 job 失败、取消、意外跳过，及未选中 job 意外运行。

Linux renderer 继续在每个发布产物封存前实际构建和验证。最新 main 的该步骤为 18 秒；复用需要额外建立源码、基础镜像和封存镜像之间的可信关联，本次没有为省这一步引入跨运行信任路径。浏览器安装缓存尚未采用：当前两个 job 都需要 Chromium/WebKit 及系统依赖，缓存不能省去系统库安装；没有同范围 CI 实测净收益前不增加大二进制 cache 的 restore/save 成本。现有 npm/pip 缓存保留。

## 验证与测量

同产品基线的完整成功 CI：[34041415382](https://github.com/itscly2026/same-page/actions/runs/34041415382)。包括客户端、Worker、迁移、完整 visual/smoke、PWA、performance 与 Linux renderer。

本机统一使用 Node 24。默认 Node 25 的 localStorage 环境错误不计入基线。初次改后客户端与基线浏览器同时运行出现等待超时，停止资源竞争后原样重跑通过；没有放宽等待。局部重构最初测到旧视口宽度，已用布局条件等待修正。

- 基线 Node 72/18 文件，client 365/49 文件；client 12.66 秒，setup 累计 9.58 秒。
- 改后 Node 78/21 文件，client 359/46 文件；独立 client 11.49 秒，setup 累计 6.71 秒。累计指标不是可直接相减的墙钟收益。
- 基线完整 visual 46/46，105.43 秒。最终全套及 CI 数据见后续验证记录。

自动化 WebKit API 故障与浏览器重启不等于 iOS PWA 实机断网重启验收。
