# #141 批注显示与阅读偏好验证

> 历史记录：本文描述当时的实现与验证。#156 已移除图片显示、专属 renderer 及其部署/测试入口；相关旧命令和路径不再适用。当前决定见 [ADR0013](../adr/0013-provide-independent-image-score-display.md)，资源处置见 [退役步骤](../operations/image-renderer-retirement.md)。原测量不代表当前性能或 Safari 17.5 真机验收。

实现范围：[简化批注显示、编辑目标与云盘阅读偏好](https://github.com/itscly2026/same-page/issues/141)。独立 worktree 分支 `codex/issue-141`，基线 `6de48820dd506a0983462700b936acdd5129009f`。没有迁移、合并或生产部署。

## 行为与证据

| 场景 | 验证结果与截图 |
| --- | --- |
| 阅读偏好入口 | 第一组为五个共享层的默认显示；所属云盘可见，颜色进入独立次级页面。[手机](evidence-141/webkit-320-preferences.png)、[桌面](evidence-141/chromium-1440-preferences.png) |
| 本谱显示 | 五个完整行标签绑定原生 checkbox；个人层独立显示“始终显示 / 仅自己可见”。只在有覆盖时出现整体恢复。[手机展开](evidence-141/webkit-320-display.png)、[iPad 竖屏](evidence-141/webkit-834-display.png)、[本谱覆盖](evidence-141/webkit-score-override.png) |
| 默认 → 覆盖 → 恢复 | 先关闭云盘 E 默认显示；进入乐谱后 E 不显示；整行点击创建本谱覆盖，恢复后重新采用云盘默认。请求记录确认写入本谱端点，恢复发送 `subscribed: null`。 |
| 颜色自定义 → 恢复 | 颜色页独立显示批注预览，每层仅有“云盘默认”或“自定义”一种状态。自定义后才出现恢复动作；恢复后刷新仍沿用默认。[颜色页面](evidence-141/webkit-320-colors.png)、[自定义](evidence-141/webkit-color-custom.png) |
| 自动保存失败 / 重试 | 云盘显示、颜色、本谱显示分别注入一次 503，保留已确认值并显示重试。重试发送原变更，成功后更新控件。不同层同时保存时，各行反馈互不覆盖。[颜色失败](evidence-141/webkit-color-save-failure.png) |
| 写入目标 / 无编辑权 | 展示完整英文层名、共享受众和个人隐私；无权限行显示授权原因，点击可查看说明。[手机](evidence-141/webkit-320-target.png)、[手机横屏滚动后](evidence-141/webkit-740-target.png)、[iPad 横屏](evidence-141/webkit-1194-target.png)、[权限说明](evidence-141/webkit-permission.png) |
| 编辑未显示层 / 退出恢复 | 有 E 编辑权的成员选择未显示的 E 后，只显示 E 批注，页面位置控件禁用，工具栏持续显示当前目标；退出后 E 隐藏，Personal 恢复。编辑全过程没有偏好写入。[编辑 E](evidence-141/webkit-edit-hidden-layer.png) |
| 云盘管理 / 授权 | 保留五个固定英文层名、云盘默认色与独立编辑授权；不提供 Personal 管理或订阅。[管理](evidence-141/webkit-320-management.png)、[授权](evidence-141/webkit-320-grants.png) |

## 自动化验证

- `src/client/app.test.tsx` 和 `src/client/routes/reader-page.test.tsx`：70 项通过；包含并发保存隔离、颜色失败重试及恢复、未订阅层编辑且不改变偏好、锁页与退出恢复。
- `visual-report/layer-preferences.test.mjs`：Chromium / WebKit 均通过。阅读面板、目标面板、默认显示、颜色页覆盖 320×740、740×320、834×1194、1194×834、1440×1000；管理及授权覆盖手机、iPad 横竖屏和桌面。检查文档无水平溢出、整行及按钮至少 44px、滚动后关闭/返回可达；键盘 Space 操作显示复选框。
- `check:full` 的全部检查阶段已完成：原生 renderer、PWA 更新接管、14 项 CI scope、lint、typecheck、37 项 unit、288 项 client、73 项 Worker、33 项视觉回归、迁移、生产构建 / precache、6 项浏览器 smoke、加载性能。
- 本地不是一次无重试的串行绿灯：完整运行先暴露新增整行点击测试的错误文本定位，修正后两引擎各自复跑通过，其余 31 项视觉回归通过。续跑时未继承 Python 环境的图像 smoke 已显式指定虚拟环境重跑，2 项通过；IndexedDB 重开 smoke 单独补跑通过。macOS 测试服务清理曾出现 `kill EPERM`，清理后加载性能再次运行以 exit 0 完成。这些环境/测试定位问题没有引入产品绕过逻辑。
- 视觉报告生成器最终以 exit 0 完成 8 个相关场景，验证独立偏好页面、颜色恢复、默认显示持久化、失败保留原值、未显示层编辑与退出、授权保存；同步移除了脚本中的旧复选框名称。

交互原始记录：[Chromium](evidence-141/chromium-interactions.json)、[WebKit](evidence-141/webkit-interactions.json)。记录仅含合成夹具的 URL、变更体与故意注入失败标记，不含真实用户数据或凭证。

复现：

```sh
LAYOUT_CAPTURE_DIR=artifacts/verification/issue-141 node --test visual-report/layer-preferences.test.mjs
PATH="/tmp/same-page-141-venv/bin:$PATH" npm run check:full
```

本机完整检查使用临时 Python 虚拟环境安装 `renderer/requirements.txt`；没有修改系统依赖或仓库依赖锁文件。完整截图矩阵位于忽略目录 `artifacts/verification/issue-141`，本报告精选截图已随 PR 提交。

## 审查与验收边界

Standards 审查：0 项；固定 ESATB/P、偏好和权限边界、旧呈现路径清理及文档同步符合仓库要求。Spec 审查：0 项；未发现遗漏、越界或错误实现。两项审查由独立子代理对基线至 `7a4a10d` 的变更完成。

截图来自 macOS 上的真实 Chromium / WebKit 引擎与合成 API/PDF 夹具，手机和 iPad 仅为视口模拟。颜色输入通过浏览器控件赋值触发，未验证 iOS 原生颜色选择器。未完成真实 iPhone/iPad Safari、Pencil、软键盘、VoiceOver、弱网/离线及生产认证云盘验收；本报告不把浏览器模拟或自动化通过等同于这些验收。
