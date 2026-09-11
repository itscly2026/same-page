# #262 阅读器笔记稳定性复核

基线为 2026-09-11 的 `origin/main`（`d06acf0`），在 `codex/issue-262` 独立 worktree 修复。

## 复现与根因

- `vitest run --config vitest.client.config.ts src/client/annotations/annotation-overlay.test.tsx -t 'moves text|focuses new text'`：修改前四项失败。文字拖动期间 `left: 60%`，释放立即变为 `20%`；清除最终预览早于本地异步数据接管。输入框仍存在 `placeholder="点按输入文字"`。
- `vitest run --config vitest.node.config.ts src/client/annotations/highlighter-geometry.node.test.ts`：修改前三项失败，同笔折返与交叉覆盖深度为 1，目标为 2。根因为整笔扫过区域只求并集。
- `AnnotatedPdfPage` 的 overlay key 含工具，工具切换会重建显示层。修改后真实阅读器在文字、选择、荧光笔、整条橡皮之间切换时逐一检查 DOM 节点身份及 SVG 路径保持不变；未完成笔迹取消并撤销其检查点。
- WebKit 的缩放回归在使用 DOM 测量宽高比时失败：归一化路径坐标例如 `396.16428883973214` 变为 `396.1643321185714`。这证明亚像素尺寸取整导致几何重算，不能证明用户报告的肉眼闪动全部由此引起。使用 PDF 固有宽高比后，Chromium/WebKit 的放大与缩小检查要求路径完全相同。
- 浏览器笔迹测试等待最终释放位置接管后再比较，不能把中途保存检查点误认为最终几何。

## 修复边界

最后主动选择的工具沿用工具样式的 owner 隔离范围，本机跨谱及刷新保留；首次及无效偏好回退文字。偏好读写失败不阻断编辑。打开乐谱仍为阅读模式。

释放后的对象预览持续到本地显示数据接管；本地写入失败保留编辑器重试路径。编辑器提供按入队顺序标记的已提交对象意图，处理连续拖动和显示数据跳过中间位置时的快速撤销。取消交互不丢弃已经释放的修改；退出编辑层卸载临时投影。

荧光笔只对当前笔头新进入的区域沉积颜色，排除相邻采样共享的接触面，离开后返回才增加一层；SVG、命中和 PDF 导出继续共用几何。圆头、扁头、水平及斜线密集采样、原地重复点、三次覆盖和 live prefix/恢复数据一致性均有回归覆盖。

没有 schema/API 变更或数据重写。已有同笔交叉在新客户端会按新规则显示得更深；旧客户端更新前仍按原规则显示。普通笔及已有对象的工具样式不变。

## 验证范围

最终本地验证使用 Node 24.21.0：107 项单元测试、590 项客户端测试、25 项 Chromium/WebKit 浏览器测试全部通过；lint、typecheck 和生产构建通过。浏览器组以单文件并发运行。

单元与组件测试覆盖恢复工具及独立样式、用户/访客隔离、存储异常、拖动释放、失败重试、连续修改、快速撤销、一次完整拖动的一次撤销及工具切换取消。

浏览器验证包含 `reader-annotation-stability.test.mjs`、`highlighter-nib.test.mjs`、`reader-experience.test.mjs`、`pdf-export.test.mjs`、`reader-mobile-editing.test.mjs`。其中荧光笔测试直接对比 SVG 与导出 PDF 的像素：30% 单层黄色的蓝通道约 179，同笔或异笔两层覆盖约 125。

真实 iPad/Pencil 与已安装 PWA 的缩放闪动、硬件笔事件和软键盘仍需设备验收。桌面 Chromium/WebKit 自动化不代替这些结论。
