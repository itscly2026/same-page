# #142 阅读器工具、保存状态与恢复验证

> 历史记录：本文描述当时的实现与验证。#156 已移除图片显示、专属 renderer 及其部署/测试入口；相关旧命令和路径不再适用。当前决定见 [ADR0013](../adr/0013-provide-independent-image-score-display.md)，资源处置见 [退役步骤](../operations/image-renderer-retirement.md)。原测量不代表当前性能或 Safari 17.5 真机验收。

关联 [#142](https://github.com/itscly2026/same-page/issues/142)。实现于独立 worktree，初始基线 `6de4882`，随后 rebase 到 `main` 的 `5c238c0`。范围为阅读器呈现及既有会话的恢复；没有更改服务端转换、权限协议、数据库结构或 #141 的图层信息架构。

## 最终行为

- 默认隐藏工具、页内位置与编辑锁页规则保留。返回、编辑、图层、更多统一为 21px 图标、至少 44px 触控区域；页码并入工具底座，减轻渐变和阴影。文字输入时隐藏批注工具，顶部图标不移动。
- 更多使用 React Aria Popover/Dialog：手机为可滚动底部面板，平板/桌面为紧凑浮层。按页面布局与缩放、谱面显示方式、本机离线副本、保存与同步、帮助组织。本机显示偏好折叠，帮助直接解释阅读操作并进入诊断。
- 本机保存只根据完成的 IndexedDB 写入和批注记录表达；无批注或尚未读到记录不会显示“已同步”。真实同步锁的活动覆盖前台和后台恢复，outbox 数量提供正在同步的项数；云端已接受的对象在无草稿、outbox、冲突及错误时显示“已同步”。离线草稿与离线谱面副本分别表达。
- 失败写入保留在当前编辑器，提示尚未可靠保存并提供重试。保存期间冻结文字/字号及取消，防止慢写入期间丢失新输入；保存失败后取消文字会丢弃这次未写入意图。Data Router 的编辑离开保护覆盖链接和浏览器后退，避免卸载编辑器；页面刷新/关闭另有 beforeunload 提示。
- 原有冲突的放弃、重放和保留两份能力保留；失权说明、异常原因和重试仍可达，其它有权限的批注继续走既有同步实现。后台恢复开始清除历史操作反馈，避免成功后仍显示上一次失败。
- 离线状态采用当前模式的完整校验结果。切换模式或版本清除过期成功文案；下载迟到时核对当前模式/版本，不能以另一模式的成功承诺当前可离线。其它标签仍区分尚未下载、校验中、可用、损坏、旧版待更新。
- 显示切换沿用 ReaderSession，原 document/lease 保留到新页实际绘制成功；旧页重新绘制不会清除回退点。失败或超时恢复原谱面，代际检查仍丢弃迟到结果。失权云端资源不作为回退来源。目标页绘制失败保留当前页，并提供重试翻页。
- 每个路由有任务对应的加载标题、导航、退出与重新加载入口。偏好页显示“正在加载我的偏好”；模块加载失败由路由边界接住，页脚保持在边界外。

## 自动验证与证据边界

新增/扩展测试覆盖同步状态派生、持久化失败及取消、慢写入、后退保护、翻页失败重试、显示切换保留、旧页重复 ready、下载时切换模式、路由加载/失败。既有离线生命周期、OCC 冲突、失权隔离与其它操作继续同步的回归一并执行。

`visual-report/reader-status.test.mjs` 使用真实 Chromium 客户端、PDF canvas、IndexedDB 和 outbox；API、网络事件与存储故障由测试注入。390×900 和 834×900 均实际执行：打开 → 编辑文字 → 浏览器后退被阻止 → 存储写入失败 → 再次后退仍保留文字 → 恢复写入 → 离线待同步 → 手动同步失败 → 重连自动同步接受 → 下载失败 → 显示方式失败回退 → 继续显示谱面。另有首屏加载和打开失败截图。每个尺寸没有未处理的页面错误。

已有 Chromium/WebKit 浏览器布局测试覆盖 320、360、390、768、834、1194px；包括顶部位置稳定、44px 目标及文字编辑器在模拟 WebKit 可视视口下的布局。这些是浏览器模拟，不是实机 iPad/iPhone、Pencil、软键盘、安装版 PWA 或真实飞行模式验收。#137 的服务端转换、生产部署与实机验收仍独立。

## 截图

| 场景 | 证据 |
| --- | --- |
| 手机/平板更多 | [手机](issue-142/390-menu.png)、[平板](issue-142/834-menu.png) |
| 编辑与文字输入 | [编辑](issue-142/390-editing.png)、[文字](issue-142/390-text.png) |
| 本机待同步/云端接受 | [离线草稿](issue-142/390-offline-draft.png)、[已同步](issue-142/390-synced.png) |
| 存储/同步失败 | [本机保存失败](issue-142/390-storage-failed.png)、[同步失败](issue-142/390-sync-failed.png) |
| 下载/显示失败 | [下载失败](issue-142/390-download-failed.png)、[保留原谱面](issue-142/390-display-failed.png) |
| 首屏加载/打开失败 | [加载](issue-142/390-loading.png)、[打开失败](issue-142/390-open-failed.png) |

交互摘要见 [evidence.json](issue-142/evidence.json)。重跑测试会生成完整截图到 `artifacts/verification/issue-142/`；这里保留经查看的代表截图，作为 PR 可审阅证据。

## 审查

Standards 与 Spec 两轴独立审查并复核：最初发现的回退资源过早释放、取消文字后重试复活、保存等待期间丢字、浏览器后退丢失内存写入、跨模式离线承诺、历史同步失败残留均已修复。最终两轴均无剩余发现。

## 复现命令

本机原生图片 smoke 需要仓库 `renderer/requirements.txt` 的固定版本依赖；普通系统 Python 未必具备它们。本次使用临时虚拟环境，未改动系统 Python：

```sh
python3 -m venv /tmp/same-page-issue142-renderer
/tmp/same-page-issue142-renderer/bin/python -m pip install -r renderer/requirements.txt
/tmp/same-page-issue142-renderer/bin/python renderer/verify.py
PATH="/tmp/same-page-issue142-renderer/bin:$PATH" npm run check
```

PDFium 基准图校验通过。初次 smoke 因系统 Python 缺少 Pillow 而转换失败；另外已将图片 smoke 的更多菜单查询更新为最终 Dialog 语义。早期两次单独浏览器测试曾在全部交互完成后遇到本机子进程清理 `EPERM`，后续独立重跑及完整视觉套件通过。

## 与最新 main 的集成复核

保留 #141 的“显示哪些批注 / 写到哪里”和当前编辑层提示，以及 #143 的诊断发送面板。保存或失败期间仍显示当前编辑层，暂时禁用图层、工具及历史操作，重试成功后恢复。更多在编辑期只提供帮助和诊断；打开诊断时收起更多，防止 Popover 遮挡诊断面板。诊断打开时拦截底层翻页快捷键，关闭后焦点返回“更多”，编辑状态保留。

Rebase 后 lint、typecheck、41 项单元、314 项客户端及 83 项 Worker 测试通过。36 项视觉断言全部通过；上传队列文件的 macOS 子进程清理遇到 `EPERM`，Chromium/WebKit 两项独立复跑通过。生产构建及 precache 审计通过。真实 Chromium/WebKit + Worker/D1 的诊断测试扩展了菜单退出、标题实际无遮挡、阅读态键盘不翻底层谱面及关闭后焦点恢复断言；阅读器持久化、断线重连、下载/显示失败的完整交互也通过。

更新后的 [手机菜单](issue-142/390-menu.png)、[编辑目标](issue-142/390-editing.png) 和 [平板诊断](issue-142/diagnostic-webkit-reader.png) 已重新查看。其余代表截图保留初次实现的场景证据；完整重跑产物位于 `artifacts/verification/`。浏览器/视口模拟仍不代表实体设备或生产验收。
