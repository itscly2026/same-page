# #302 统一横向翻页验证

2026-09-13，macOS 本地 worktree，Node 24.21.0。测试覆盖阅读／编辑、适应页面／放大、翻页／连续布局；横向完成规则只由 `usePagedReader` 决定。数据库、API、IndexedDB 与已保存笔记格式均未改变。

## 自动化结果

- Node 单元测试：26 个文件、117 项通过。
- 完整客户端测试：`vitest run --config vitest.client.config.ts --maxWorkers=1`，79 个文件、707 项通过。首次并发完整运行有 9 项失败；其中 3 项是本次替换的旧翻页／测试几何合同，其余 6 项隔离重跑通过。没有扩大超时或添加重试。
- `npm run build`（含 typecheck 与 precache 校验）、ESLint 通过。
- 既有 Chromium/WebKit 浏览器回归 17 项通过：`continuous-reader-layout`、`reader-mobile-editing`、`reader-canvas-layering`、`reader-text-layout`。
- 新增 `reader-navigation.test.mjs`：Chromium、WebKit 各 8 组组合通过，另有 1 项 Chromium 原生触摸测试通过。第二页使用不同尺寸并旋转 90°，检查跟手、取消后缩放、成功后目标比例与居中、编辑工具保留。
- 原生 Chromium 输入协议验证纵向 `touchmove` 不被取消、释放后仍有惯性，横向由共享导航消费。WebKit 桌面不支持构造 `Touch`；其连续模式测试发送完整触点快照检查真实 DOM 上的 TouchEvent 监听路径，不作为原生 iPad 惯性证明。
- 手势／pager／编辑器回归涵盖反向收回进度、平移不计入速度、同帧双指识别、替换触点清理、平移转捏合不重复位移、文档切换取消旧准入、保存失败与对象归属。

运行浏览器测试：`node --test --test-concurrency=1 visual-report/reader-navigation.test.mjs`。也可用 `NAVIGATION_CASE=page-read-2` 单独定位组合；`LAYOUT_TEST_ORIGIN` 可复用已经启动的本地 Vite 测试服务器。CI 保存 `artifacts/verification/` 中的截图。

## 审查与预览

已执行 code-review 的 Standards／Spec 双轴审查。Standards 无硬性问题，重复呈现调用已合并；Spec 找到的触点替换残留预览、平移转捏合重复位移均已修正，新增回归通过并经复核。

本地交互预览使用 fixture 云盘／谱面，不连接生产数据；本次会话地址为 `http://127.0.0.1:49403/choirs/visual-choir/scores/visual-score`，只在本机进程存活时可访问。以下为 WebKit 桌面真实布局截图，目标页特意旋转以检查不同几何。

| 布局 | 拖动中 | 完成后 |
| --- | --- | --- |
| 翻页 | ![翻页拖动](issue-302/webkit-page-drag.png) | ![翻页完成](issue-302/webkit-page-complete.png) |
| 连续 | ![连续拖动](issue-302/webkit-continuous-drag.png) | ![连续完成](issue-302/webkit-continuous-complete.png) |

## 尚待真机验收

未执行 iPad Safari／安装后 PWA 真机验收，不能用桌面 WebKit、模拟触摸或截图替代。验收时记录设备型号、iPadOS 版本、Safari／主屏幕启动方式；重点检查单／双指交接、连续纵向惯性、捏合触点增减、Pencil 对象归属和翻页跟手。提交 PR 不代表已合并或部署。
