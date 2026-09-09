# 阅读位置恢复导致首屏超时：2026-09-09 诊断

## 生产事实与边界

设备报告和生产 `/api/health` 均为 `8aa7d4e67e7893f08d44dbc3388ee6d6065c6aee`，包含 #223。设备为 iOS Safari 独立 PWA。报告只有 `pdf / internal / prepare / reader-presentation / TimeoutError / timeout`，待同步和冲突计数均为 0。该阶段说明会话持有文档，但没有成功确认首屏，不等于已经定位 PDF 解码故障。

用户提供的对照：旧谱失败；新上传谱可打开；另一个设备均能打开；退出 PWA 后重新进入和清理单份本机谱面文件均未恢复。布局和旧页码不记得。诊断未采集布局、当前页码或实际画布页码，因此不能把以下代码复现当作已经读取了设备的实际阅读设置。

## 已复现代码根因

`ContinuousLayout` 在第一次渲染的容器宽高仍为 0 时执行恢复定位，并提前写入 `alignedPage`。这次定位无法建立正确位置，后续真实尺寸到达时被相同页码判断跳过。虚拟列表仍只画开头几页，而 ReaderPage 只接受保存页码的首屏确认，加载遮罩不会消失。

另一个相关缺陷：滚动事件使用 `getVirtualItems()` 判断当前页。事件可能先于虚拟窗口刷新到达；目标位置不在旧窗口时，回退到旧窗口第一项，导致当前页码与实际视口不一致。仅延后初次定位仍会触发该缺陷。

最小修正：等待非零容器尺寸再执行恢复；用全量测量的 `getVirtualItemForOffset()` 计算滚动位置的页码。没有增加总超时，没有等待全部页面解码，没有更改同步或离线存储。

## 对照证据

- 实际旧 PDF、820×1148：翻页模式第 1、8、11 页均正常；连续滚动第 1 页正常，第 8、11 页首开和重开失败，Chromium/WebKit 均复现。
- 原版实际等待 45 秒后，生成与设备报告完全相同的 operation/category/stage/step/errorType/pdfReason；没有 PDF 解码或网络失败记录。
- 原版主动滚动后，目标附近画布均可完成，但当前页码被旧虚拟窗口错误写成 1；只修初次定位仍失败。
- 两处修正后，同一实际旧 PDF、第 8/11 页、两种浏览器、首开/重开全部通过。
- 仓库回归使用自行生成的 11 页 PDF，不保存生产 PDF、文件名、用户身份、笔记或故障报告正文。

## 可重复验证

使用仓库 CI 的 Node 24，在 worktree 执行：

```sh
node --test visual-report/reader-presentation.test.mjs
node --test --test-name-pattern='continuous editing|continuous pinch' visual-report/reader-immersive.test.mjs
npm run test:unit
npm run test:client -- --maxWorkers=2
npm run lint
npm run typecheck
npm run build
```

新增回归覆盖靠后页码、短末页和持久化后重开，在原版 Chromium/WebKit 均失败，在修正版本均通过；原有连续滚动编辑与缩放 6 项通过。完整 Node 测试 77 项和客户端测试 502 项通过；lint、typecheck、build、precache 校验通过。

本机第一次高并发测试存在超时；修正原有 virtualizer 测试替身、收敛客户端并发后全部通过。Node 25 浏览器验证曾出现 Undici `setTypeOfService EINVAL`，改用 CI Node 24 完成验证，未扩大测试超时或修改断言规避。

## 当前交付范围

代码与回归测试在独立分支交付，合并、部署状态以 PR 为准。原设备修复后验收仍待进行；现有报告缺少阅读位置证据，不能声称已最终确认该设备必然由此触发。
