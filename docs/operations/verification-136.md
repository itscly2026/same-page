# #136 乐谱访问与离线生命周期

## 实施边界

基线：5204197。前置 #135 的 annotation-state 是批注持久化命令边界，跨谱恢复留在应用层。

ReaderSession 公开订阅快照、打开、重新确认、重试图层、下载与释放命令。会话固定 scope 并拥有 PDF 身份和来源；快照包含加载结果、云端状态、图层能力及下载结果。页面保留渲染、手势、编辑交互；不得暴露会话内部 setter 或 I/O。每个会话独立失效标记；释放后所有迟到结果无效；重复前台事件合并。云端确认版本优先，旧离线版本保留但不能冒充新版。

离线查询与完整校验分离；完整校验在首次观察记录、实际打开与下载完成执行。记录变化使校验失效，前台事件不触发逐行重新读取。PDF Blob 为不可变值，已读取的 Blob/ArrayBuffer 由会话持有，IndexedDB 删除旧记录不撤销该值。新记录完整校验、原子激活并删除旧记录；失败事务保留旧记录和所有草稿。PDF.js 文档租约独立计数，过期缓存只停止复用，最后一个持有者释放才销毁。

检索使用 NFC、小写和 trim 后的字面包含语义，SQL instr 与客户端 includes 一致，避免 LIKE/GLOB 的 50 bytes 限制，不截断输入。恢复与列表使用相同的严格 expiresAt > now 边界。

测试迁移：保留 route 交互/视觉、Worker HTTP/D1、PWA 更新和加载性能测试；新增会话命令交错与离线生命周期行为回归；删除页面来源编排的重复路径。复用 browser-tests/storage-fixture.mjs。

## 验证

本地实现与验证记录如下。

### 模块及释放规则

- ReaderSession 的 open/refresh/retryLayers/download/dispose 是命令；getSnapshot/subscribe 是观察接口。会话拥有 scope、已确认 PDF 版本、来源代次、文档租约、能力与下载结果。页面仅消费结果，编辑模式、手势与 PDF canvas 仍独立。
- annotation-state 的 readAnnotationLayers/readScoreAnnotationState 在 owner 事务中提供快照及 layersReady；页面不直接访问批注表。图层落盘尚未被订阅者观察时，编辑能力仍处于准备中。
- 活动 workspace 捕获 sessionEpoch；prepareOfflineScore 再次捕获，激活事务校验 owner 和 epoch。因此 A→B→A 不会让旧下载复活。退出阅读器后结果不再挂载；已经启动的完整离线下载可以完成其持久化事务，失败或身份失效不会激活半成品。
- inspectOfflineScore 合并同 scope/epoch 的在途读取和校验；Dexie storagemutated 使共享结果失效，覆盖跨标签写入。验证器最多并发两项，只有同一不可变 Blob 实例可共用 hash 结果。观察查询使用 scope 索引 count 注册变更，不读取 PDF；首次观察、打开仍检查实际 Blob。
- 更新离线版本在一个事务内比较下载开始时的活动记录，再删除旧记录并写新记录；另一个阅读器先完成的激活不能被迟到旧下载覆盖。另一个阅读会话已读出的 Blob/ArrayBuffer 仍持有内容，不会受 IndexedDB 引用删除影响。PDF.js 旧租约最后释放才 destroy。注销/身份清理会强制清除对应内存文档，普通换版不强制销毁其它阅读者。

### 基准（本机 macOS / Node 25.9 / 配套 Playwright）

在隔离 worktree 的 5204197 和本次工作树运行相同脚本、固定样本。加载脚本使用 WebKit，API 受控延迟 75 ms，返回云盘网络延迟 5000 ms；这是桌面夹具测量，不是生产网络基准。单次前后数据不用于宣称统计显著提升。

| 样本 | 5204197 | 本次 |
| --- | --- | --- |
| 首次打开 | 229 ms | 220 ms（另一次 234 ms） |
| 再次打开 | 31 ms | 31 ms |
| 50 × 1 MiB 副本，前台事件批次追加完整读取 | 50 次 / 50 MiB | 0 次 / 0 MiB |
| 同谱 8 次换版后可达 Blob 记录 | 8 / 8 MiB | 1 / 1 MiB |
| 真实清单条目 | 60 | 59 |
| 基线真实清单逐文件 stat 总字节 | 5,403,008 | 4,484,922（减少 918,086 bytes，约 17.0%） |

存储数字为 IndexedDB 可达 PDF payload，不将 SQLite 文件回缩或浏览器物理空间回收时间冒充测量。列表测试保留首次全量校验，事件后观察 250 ms；把同一测试放回基线会失败并报告追加 50 次读取，换版测试在基线报告 8 个记录。

### 测试迁移与实际证据

| 边界 | 保留/新增覆盖 |
| --- | --- |
| ReaderSession | dispose 后迟到结果无发布、前台事件合并；route 保留旧响应、来源切换、快速导航、失权/回收站/离线/图层重试 |
| annotation-state 读取 | owner 事务快照、明确图层准备结果；原路由交互回归继续通过 |
| 离线生命周期 | 50 谱、8 次换版、持有旧 Blob、quota 回滚、同大小损坏、并行损坏、并发上限、在途读取合并、epoch ABA |
| Worker HTTP / D1 | 长中文、百分号/下划线/反斜杠字面查询；到期前 1 ms、恰好到期、到期后；未清理到期拒绝恢复、清理后仍拒绝 |
| 真实浏览器 / Worker / D1 / R2 / IndexedDB | access-smoke 的检索→下载→断网刷新→发布新版→失败保留旧版→重试成功；storage-smoke 的浏览器进程重启且后端关闭后断网读取；annotations-smoke 的离线编辑→重连同步和交错 |
| PWA / 发布产物 | verify-pwa-update 保留用户确认更新、离线交接；每次 build 审计真实文件/Workbox 清单；改名设计来源重入和缺失 PDF worker 回归 |
| 视觉 | 原有 31 项浏览器视觉回归保留；visual:report 重新生成并人工查看阅读控制、文本编辑、密集谱面截图 |

删除页面重复 bootstrap/来源/图层编排及仅比较 source 对象引用的内部测试。保留并修正路由离线 fixture 为完整 E/S/A/T/B + personal 模型，没有用部分图层冒充已验证副本。

完整 npm run check:full 已通过：14 CI、37 node、276 client、7 Worker 单元、63 Worker/D1 集成、31 视觉回归、迁移、构建、真实浏览器 smoke、PWA 更新及加载预算。复审后的共享校验调整另跑相关 42 项路由/离线测试通过。最终两项访问浏览器测试均通过，包含已到期但未清理的回收站乐谱；产物审计与截图在本地 artifacts/verification，完整视觉报告位于 artifacts/visual-report/index.html。

Standards review 原发现 2 项（不同 Blob 共用成功结果、缩页越界），已修正且复查无阻断；Spec review 原发现 2 项（只读快照被覆盖为失败、同一校验漏洞），已修正，另补共享读取入口以合并 IndexedDB 克隆前的读取任务。

未进行生产部署。真实 iPad/Android/Pencil/软键盘及大陆网络继续按 #9 做设备验收，桌面 Chromium/WebKit 和截图不替代这些证据。

官方平台依据：[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/) 明确 LIKE/GLOB pattern 上限为 50 bytes。本次使用 instr 避开 pattern 限制，客户端与 Worker 使用同一 NFC 文件名规范化函数。


### Standards

原 2 项发现：不同 Blob 共享成功验证、PDF 缩页后页码越界。均补回归并修复；独立复查未发现新增阻断问题。

### Spec

原 2 项发现：只读离线能力被迟到失败覆盖、并行完整性漏洞。均修复；另将读取任务合并提前到 IndexedDB 克隆之前，并在存储写入时失效。保留实际打开校验，未以跳过验证换取性能数字。

两轴原发现各 2 项，最终已修正；设备与生产发布边界如上。
