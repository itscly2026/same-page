# 测试深度清理 #174

基线：`fc0717b28a2e95d111dd2a55e98bfc344ee1a469`；独立 worktree，PR #175。第一轮 `9257ec4` 没有减少测试数量，反而增加 setup 分组和审计代码；完整 CI 也没有稳定提速。因此第二轮以删除重复保护和无效证明为主，撤回收益不足的环境白名单。

## 风险去向

| 删除 / 合并项 | 理由与最终覆盖位置 |
| --- | --- |
| app 的偏好编辑成功、固定层列表两项整路由用例 | layer-preferences 实际浏览器覆盖偏好、管理和编辑；app 的重叠请求失败回滚仍保留 |
| app 的多成员和零成员入口两项 | home-entry 使用实际 AppRoutes 覆盖 0/2 成员及邀请入口；保留成员与管理员链接 |
| app 的缓存恢复、搜索竞态两项 | DriveLibrary 状态边界、useDriveLibrary 和 drive-library-lifecycle 的真实历史返回/滚动恢复；app 仍验证成员文件名搜索不发网络查询 |
| app 的逐文件上传一项 | upload-dialog 保留非法文本、PDF 错误、重名、FIFO、失败重试、身份切换和丢失响应；upload-queue 浏览器保留路由入口 |
| join-code-field 的“键盘删除”一项 | 原测试只 fireEvent.change 写入值，没有模拟键盘；规范化和完整输入行为仍保留 |
| reader-layout-canvas 两项及伪造 paged/continuous HTML 用例 | mock 自己规定宽度后再比较 style 不能证明渲染正确；reader-immersive 两引擎实际 PDF canvas、批注 overlay、页面四边对齐，覆盖分页 fit/zoom 和连续 zoom；原有横竖屏与缩放流程保留 |
| 整个 drive-entry-library 文件（两引擎） | 成员数量转交 home-entry；搜索/排序、长文件名 100 行、44px 和键盘文件信息并入 responsive-navigation；真实缓存、重启、失败恢复由 lifecycle/offline 控件及 storage/offline-entry smoke 保留 |
| ux-refinement 的完成编辑流程 | layer-preferences、reader-immersive、reader-mobile-editing 已覆盖进入/退出、缩放保留及重新打开页面导航；层排序与显式保存用例仍保留 |
| diagnostics 的无效 JSON 浏览器循环 | diagnostics.node 的真实解码和 ReaderPage 错误 UI 已覆盖；保留实际 PDF.js HTTP 403 及网络中断到私密诊断报告的两种链路，mock 异常不足以替代 PDF.js 实际错误分类 |
| 五项文字缩放用例 | 一个共享 WebKit 页面运行短文本、小字号、中文、显式换行、长 URL 矩阵；保留原有行数/内容边界断言，中文规范比例断言；独立 44px 热区及 pinch/commit 等价性保留 |
| 客户端 setup 项目拆分、两份额外 setup、文件白名单 | 撤回第一轮复杂度；一个 jsdom setup 先卸载 React 再删数据库。三份真正不依赖 DOM 的文件仍移到 Node（invite-link、session-fetch、loading-performance） |
| layer-preferences 各宽度重复导航 | 每个页面/弹层只打开一次再遍历原视口；两个引擎仍完整执行失败/重试、颜色恢复与隔离 |
| reader-status 两宽度完整恢复流程 | 390 执行保存失败/草稿/离线同步恢复；每个状态原地检查 390/834 裁切与溢出 |
| homepage flex/grid、云盘固定间距断言 | 保留实际阅读顺序、溢出、触控目标、焦点和键盘交互；responsive-navigation 同页调整 320/390/600/768/834/1194/1440 |
| auth-methods / reader-status 成功截图 | 默认不写，无差异判定的截图仅在 LAYOUT_CAPTURE_DIR 显式报告模式生成；行为和几何断言仍执行 |
| 每个迁移文件单独启动 Wrangler | 同一数据检查点之间合并执行；真实 D1、旧数据、外键、文件名 backfill 幂等断言全部保留 |
| storage/offline-entry 仅 canvas 可见 | 增加实际 PDF 深色谱面与浅色底色像素证明，排除 UI/批注及透明、全白、全黑 |

没有改产品代码，没有新增 skip/todo、重试或加宽超时。身份隔离、个人层、OCC/outbox、版本/会话竞态、真实 D1/R2、codec、图片离线、PWA、发布产物门禁保留。减少测试声明数不等于减少风险覆盖：文字矩阵等仍执行所有有意义的数据边界。

## 模块与 CI 选择

精确审计的展示模块只有 `drive-settings-dialog.tsx`、`drive-header.tsx`、`upload-fab.tsx`；它们的产品消费者为 `routes/choir-page.tsx`。不是按目录名将整个 score-library 判为低风险：该目录内的缓存、useDriveLibrary、下载、上传和 reader 来源选择仍走全部组。只有这些展示模块（可混合文档）变更才选择 library：

- visual：drive-settings、drive-navigation、drive-library-lifecycle、upload-queue、responsive-navigation、ux-refinement。
- smoke：storage-smoke、offline-entry-smoke，保留真实访客/成员的入口与离线存储消费者。
- client/build/deploy 保留，performance 不选；renderer/codec 的独立浏览器流程不选。

混合任何其他产品路径、共享样式、reader、认证、离线、依赖、公共基础设施或未知路径，都回到 all 浏览器组。认证、offline、platform 与 app 的改动另外明确选择 PWA 交接。缺少历史仍全部验证。选择器自身变更也选择完整验证。新增消费者或改变这些模块职责时必须重新审计本清单。

`scripts/run-browser-tests.mjs` 对未知 suite/group、空集合报错；all 从目录枚举所有用例，新浏览器文件不会漏掉。required verify 测试直接执行 workflow 内的真实门禁脚本，覆盖选中 job 失败、取消、意外跳过，及未选中 job 意外运行。

Linux renderer 继续在每个发布产物封存前实际构建和验证。最新 main 的该步骤为 18 秒；复用需要额外建立源码、基础镜像和封存镜像之间的可信关联，本次没有为省这一步引入跨运行信任路径。浏览器安装缓存尚未采用：当前两个 job 都需要 Chromium/WebKit 及系统依赖，缓存不能省去系统库安装；没有同范围 CI 实测净收益前不增加大二进制 cache 的 restore/save 成本。现有 npm/pip 缓存保留。

## 验证与测量

同产品、全范围成功 Actions 样本（秒）：

| 阶段 / 运行 | runner 合计 | 关键路径 | client | migration | visual | smoke |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原基线 [34041072554](https://github.com/itscly2026/same-page/actions/runs/34041072554) | 851 | 342 | 96 | 76 | 136 | 145 |
| 原 main [34041415382](https://github.com/itscly2026/same-page/actions/runs/34041415382) | 862* | 305 | 95 | 75 | 200 | 131 |
| 第一轮 [34042495545](https://github.com/itscly2026/same-page/actions/runs/34042495545) | 782 | 310 | 70 | 48 | 190 | 124 |
| 第一轮最终 [34042898831](https://github.com/itscly2026/same-page/actions/runs/34042898831) | 880 | 345 | 87 | 59 | 201 | 149 |

*main 扣除仅 main 执行的 seal/upload/identity 6 秒，排除 deploy。原基线两个 commit 树相同。首轮均值 runner 831 秒对比原 856.5 秒仅约 3%，分布重叠，关键路径没有稳定改善。浏览器安装及 runner 速度有混杂，不将波动归因于清理；不拿 library 子集冒充完整测试收益，也不为凑样本空跑旧 CI。最终第二轮完整 CI 数据放在 PR #175 描述，避免为了记录 CI 而不断触发下一轮 CI。

原基线及第一轮：Node/客户端合计 437，Worker 95，visual 46，smoke 11；scope 从 16 增至 19。第一轮最终本机 check:full 全部通过，visual 78.91 秒；原本机 visual 105.43 秒。第二轮本机统一 Node 24，Python renderer 环境齐备。Node/客户端 427（78+349），Worker 95，visual 38；scope 19 与真实 smoke 11 保留。测试与执行代码相对原 main 净减 591 行，相对首轮最终净减 754 行，均不计文档。

错误注入证明（临时修改已恢复）：library 漏选 smoke 会使范围回归失败；真实 storage smoke 离线重开的 PDF canvas 涂白会使像素证明失败。实际批注层横移 8px 时新对齐断言失败，恢复后 reader-immersive 与 diagnostics 共 8 项通过。Spec 审查要求恢复实际 PDF.js 网络中断分类，已修复复核；两轴无未解决发现。

浏览器模拟与 WebKit API 故障不等于 iOS PWA 实机断网重启验收；本 PR 不部署产品。

### Job 与独立步骤基线（秒）

| Job / step | 原 PR | 原 main | 首轮最终 |
| --- | ---: | ---: | ---: |
| scope job | 7 | 7 | 9 |
| checks job | 281 | 287 | 254 |
| checks / Lint | 14 | 14 | 13 |
| checks / Type check | 14 | 14 | 13 |
| checks / Worker tests | 57 | 61 | 59 |
| checks / Install dependencies | 17 | 18 | 15 |
| visual job | 233 | 281 | 286 |
| visual / Install dependencies | 11 | 14 | 17 |
| visual / Install Playwright Chromium and WebKit | 70 | 57 | 54 |
| integration job | 327 | 290 | 328 |
| integration / Install dependencies | 17 | 14 | 18 |
| integration / Install Playwright Chromium and WebKit | 44 | 42 | 43 |
| integration / Verify and package the Linux renderer | 18 | 18 | 20 |
| integration / PWA update handover | 51 | 36 | 46 |
| integration / Production build | 19 | 15 | 21 |
| integration / Loading performance feedback loop | 13 | 11 | 13 |
| verify job | 3 | 3 | 3 |

Scope 完成到 checks/visual/integration 启动间隔：原 PR 4/3/2 秒，原 main 3/3/2 秒，首轮最终 2/3/2 秒；间隔包含调度与启动开销。其余主要测试步骤见上表。

第二轮本机 check:full：renderer、PWA、lint/typecheck、Node/client、Worker、38 项 visual（65.41 秒）、迁移与 build/precache 通过；11 项 smoke 中 10 项通过，图片 Chromium 在 teardown 遇到已有的 kill EPERM，完整命令因此退出 1。图片两引擎原样单独复验 2/2 通过（21.49 秒），后续加载预算及最终 lint 通过。PDF 网络分类恢复后的浏览器复验通过，不把该本机拆分验证描述为一次完整成功运行；最终完整 Linux CI 见 PR。
