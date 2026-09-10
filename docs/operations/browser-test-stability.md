# 浏览器测试稳定性与有效覆盖（#220）

## 固定基线与结论边界

基线为 `20ee0140bb37c3de4cccb2689a2ea46541f1dd91`。最新 main CI
[34292267399](https://github.com/itscly2026/same-page/actions/runs/34292267399) 通过。
历史失败 [34291482643](https://github.com/itscly2026/same-page/actions/runs/34291482643)
中，导航失败是上传按钮先隐藏又显示；offline-entry 的失败实际位于成员移除后的保留副本链接，
不是测试名所写的入口恢复。旧链仅在入口失败时截图，无法据此判断后段失败的原因。

Linux x86_64、Ubuntu 22.04、Node 24.16.0、锁文件 Playwright 1.62.1
（Chromium 1234 / WebKit 2336）上，未修改基线连续三轮四个测试均通过：
54.152、48.929、49.265 秒，失败 0/12。此机器的发行版不同于 ubuntu-latest，
只是调查基线；最终十轮使用下面的 GitHub 工作流，与 CI 使用相同 runner、Node 和锁文件。
没有复现历史产品缺陷，不把隔离测试状态宣称为产品修复；未改权限、离线、保存和滚动语义。

命令（基线与最终实验相同，预先 `npm ci`、安装浏览器并 `npm run build`）：

```sh
node --test --test-reporter=tap --test-concurrency=1 \
  visual-report/drive-navigation.test.mjs \
  browser-tests/offline-entry-smoke.test.mjs
```

## 测试取舍

| 原保障 | 决定与责任位置 | 用户风险 |
| --- | --- | --- |
| 返回关闭抽屉、再次返回前一文档，以及云盘列表/首页入口 | 保留导航主链，独立 context | 返回不能意外离开或困住用户；导航目的地正确 |
| 抽屉 Enter/Escape/焦点恢复 | 独立子测试 | 键盘用户关闭抽屉后能继续操作 |
| 滚动上传显隐 | 独立子测试，删 data-visible 等待，检查可见性、无法聚焦、重新出现后能打开上传 | 隐藏操作不拦截交互，向上滚动能上传 |
| 已聚焦上传按钮随滚动保留 | 独立子测试，检查焦点与 Enter 实际打开上传 | 键盘操作不中断 |
| 空搜索结果下上传 | 独立子测试，实际打开上传 | 没找到谱时仍可上传 |
| `.brand-link` 不存在、成员链接 href、320px 溢出 | 删除前两项内部/重复断言；删除重复窄屏断言 | 链接实际导航由导航/管理测试承担；窄屏由 responsive-navigation 的触控尺寸、裁切和溢出保障承担 |
| history.state.usr.exitCheckpoint | 删除内部状态等待 | 通过真实返回行为检查导航契约 |
| 恢复 → 编辑 → 联网 → 搜索排序 → 成员移除 | 分为恢复/联网主链与独立失权场景，各从新 profile 和已验证副本开始 | 入口失败不遮蔽失权，失权也不借用恢复过程的状态 |
| 离线排序 reload 与“本机内容”文案不存在 | 删除重复操作与否定文案；保留失权时搜索/排序状态 | DriveLibrary 和 library-view-state 测试承担持久化；responsive-navigation 承担搜索/排序控件交互 |
| 失权后保留副本、PDF 实际内容 | 保留真实 Worker 的移除操作、无权限提示、保留链接与 PDF bitmap 内容检查 | 缓存不是权限；可用本机内容不丢失，白屏不算打开成功 |
| 身份隔离、草稿、冲突、有效副本校验与 #218 待同步扫描回归 | 相邻有效测试全部保留，不修改 storage-smoke、annotations-smoke、access-smoke、验证副本与 outbox 测试 | 不以删除真实数据/权限保障换取稳定 |

WebKit 仍是新页面的 API 中断注入，静态资源在线；Chromium 仍是关闭浏览器后真正断网重启。
二者都不等同于已安装 iOS PWA 的进程冷启动或真实设备排练验收。

## 准备成本与维护入口

两文件仍按每个引擎启动一次服务：总计两个 dev server、两个 Worker fixture，
数据库隔离与随机可用端口沿用已有设施；未增加端口约定、重试或超时。
导航子测试共享 server/browser，但每项有独立 context；两条存储场景共享 fixture，
各自下载验证副本，成员移除最后执行，不依赖恢复场景的成功。
新增一次副本准备/引擎是失权场景独立运行所需，避免为每个断言重复启动 Worker。

拆分第一版（空结果尚与焦点同行）Linux 调查用时 61.094 秒，原始三轮均值 50.782 秒。
这次治理以失败定位和独立风险保障为收益，没有声称总时长下降；最终耗时以 PR 实验结果为准。
不再常态保存这些测试的截图；失败时共用 `browser-evidence.mjs`。
已审计 `scripts/run-browser-tests.mjs` 仅启动 visual/smoke，CI 不再为它额外选择 Worker 单测、
迁移、PWA 和性能检查；共享证据模块同时选择 visual/smoke/build，未知脚本仍保守兜底。

## 失败证据与有界复验

证据限本仓库合成 fixtures。认证请求在录制前完成；所有目标浏览器步骤失败时写入
`artifacts/verification/<suite>/<engine>-<scenario>/` 的 URL（无 query/hash）、
页面错误种类及源位置、遮盖输入/笔记的截图、操作 trace。服务启动/认证准备失败仍由进程错误报告。
不复制 DOM、控制台任意文本、网络 headers/body、输入值或原始异常消息。

Playwright 关闭 snapshots 仍会在 action trace 中保存 route.fulfill 参数，
所以原始 zip 只写临时目录，`sanitize-browser-trace.py` 用 Python 3 标准库清理后发布，
最后删除原始文件。清理后的 trace 保留操作时序/定位器，故意没有 DOM/network 快照。
不为该低风险包装添加镜像单测；交付时用强制失败的临时测试实际生成并检查证据，探针不提交。

`Browser stability experiment` 仅在手动 dispatch 或 PR 添加 `browser-stability` 标签时运行。
固定 checkout PR head SHA，十轮串行记录每轮退出码、完整 TAP、耗时、环境和失败证据；
失败继续收集剩余轮次，最终任意一轮失败都会令工作流失败，不挑选成功重跑。
普通 push 不触发十轮；再次实验需要重新添加标签。最终固定提交、首轮/全部十轮结果、
常规 CI 与审查结果在关联 PR 中记录，不以实验代替完整 CI。
