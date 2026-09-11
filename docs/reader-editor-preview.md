# 阅读器编辑预览 · #237

在 `codex/reader-editor-preview` worktree 运行 `node scripts/preview-reader-editor.mjs`，打开 http://127.0.0.1:4176/choirs/visual-choir/scores/visual-score 。使用原创 SATB 排版样本、合成身份与本地模拟 API；编辑器与 IndexedDB 使用真实实现。模拟服务只用于效果预览，不代表云端权限或并发同步验收，模拟服务把预览数据保存在 `artifacts/editor-preview/server-state.json`，可在重启后继续体验。

## 体验路径

轻点谱面中央 → 编辑 → 画笔/荧光笔/形状/文字 → 滑杆图标调整新建默认样式。每工具按本机用户独立记忆。再次点击当前绘图工具会在该按钮上方打开同一个样式面板，设置按钮仍可打开面板；不增加说明提示。选择工具点击笔迹或对象 → 调整属性 → 应用修改 → 撤销。文字可从所选对象进入原生输入框。画笔有等宽/压感模式，未收到压力时使用中性压力。

在支持 pen hover 的设备上，悬停不显示工具文字：画笔以约 2.5 CSS px 的淡小点提示落点，整条橡皮使用 SVG 径向渐变从中心向边缘淡出，避免 WebKit 的 CSS blur 呈现实心圆；荧光笔使用与书写相同的笔头方向，预览透明度上限为 30%。没有悬停输入的设备仍可使用所有基础编辑功能。

## 实现边界

- 普通笔复用 perfect-freehand；荧光笔复用 polygon-clipping 和 d3-polygon 计算笔头扫过的区域。SVG、Canvas PDF 导出和橡皮命中共享几何。PDF 仍保留原始内容并叠加批注图片。
- 一笔使用同一对象身份；绘制按动画帧更新，约 120 ms 一次保存检查点，抬笔/取消/隐藏时补保存。超过 5000 个采样点时降低旧采样密度，保留两端并继续采样。异常终止前最后一个尚未完成的检查点仍可能丢失。
- 当前编辑模式仍锁定本页。手掌拒触、边写边缩放、Pencil 双击/挤压没有在这一轮实现或宣称支持。
- `0022` 与 IndexedDB v13 一次性转换原有普通笔/荧光笔。没有旧客户端读写新样式的兼容层。改变内容的待同步操作使用新 opId，保留 baseVersion，由既有 OCC 机制处理已接受但响应丢失的旧操作；迁移不触碰不可变 PDF Blob。

## #237 初始验证记录

- TypeScript、ESLint、生产构建。
- 单元/客户端原有测试通过，新增几何和本机迁移测试通过；Worker 单元和集成测试通过。
- Chromium/WebKit 的 8 项导出及移动端回归通过，包含旋转裁剪 PDF、原始内容保留、透明荧光笔、文字输入布局。
- `node scripts/check-editor-preview.mjs` 验证调整样式、绘制、选择、应用、撤销、完成与刷新；截图输出到 `artifacts/editor-preview/`。
- SQL 迁移已用 SQLite 验证普通笔、荧光笔、文字和删除记录。

## 仍需验收

真实 iPad Safari 与安装 PWA 的 Pencil 悬停/压感/连续书写、中文随手写、手掌行为和异常中断；当前自动化浏览器证据不代表硬件验收。本轮 #242 的自动化验证不包含生产部署。

## 当前书写行为 · #242

- 移除右上角的实时保存成功/进行中提示，保留勾号；保存失败仍通过现有错误面板提示。
- 同一笔在离开区域后回划或交叉会叠色；相邻采样共享笔头接触区域，采样密度增加或原地停顿不会额外叠色。同笔再次覆盖与不同笔覆盖的两层 30% 涂层均为约 51% 合成不透明度。连续笔迹仍是一个对象，一次撤销即可移除。
- 新建荧光笔默认扁头，可切回圆头。历史圆头对象保持圆头，选中后可修改笔头。扁头方向只随 `twist` 绕笔轴旋转，`tiltX`/`tiltY` 不改变方向或长度；浏览器未提供旋转时使用向右下倾斜的 45° 方向，即首轮预览图中“旋转 90°”的样子。记录的姿态参与重绘与导出。
- 这是一种模拟扁头的产品映射，并非 Apple Books 的笔刷模型。浏览器提供字段不等于硬件会发送有效值。[Pointer Events 标准](https://www.w3.org/TR/pointerevents3/)规定无旋转支持时 `twist` 为 0；[WebKit 旋转支持记录](https://bugs.webkit.org/show_bug.cgi?id=296943)仍有公开构建返回 0 的报告。真实 Pencil 旋转和悬停仍需设备验收。
- 新增 Chromium/WebKit 像素测试验证圆头/扁头交叉处在屏幕与导出中均正确叠色；合成 pen 事件测试验证姿态保存、悬停形状、撤销以及安静的成功保存界面。它们不代表真实硬件事件验收。
- 普通笔的自交轮廓使用 nonzero 填充；SVG、命中检测与导出遵循同一规则，避免交叉处被挖空。
- 等宽/压感和圆头/扁头采用 React Aria Button/onPress，处理笔接触后缺少 compatibility click 的序列，保持鼠标和键盘操作。
- 正常保存检查点不禁用底部工具栏；写入、撤销和重做仍由 editor 队列串行执行。保存失败仍禁用工具并显示恢复入口；完成编辑仍须等待保存成功。
- 对标 [Apple Books PDF Markup](https://support.apple.com/en-ie/guide/ipad/ipadca8ec5ef/ipados) 与 [Apple Pencil 交互指南](https://developer.apple.com/design/human-interface-guidelines/apple-pencil-and-scribble) 的直接书写和笔可操作界面；本轮没有真实 Apple Books 并排观测，不将产品映射描述为 PencilKit 的精确复刻。

## #242 验证

- ESLint、TypeScript、生产构建通过；86 项 Node 单元测试、519 项客户端测试通过（本机 Node 25 使用 `NODE_OPTIONS=--no-experimental-webstorage` 避免原生 Web Storage 与 jsdom 冲突）。
- `visual-report/pencil-writing.test.mjs`、`highlighter-nib.test.mjs`、`pdf-export.test.mjs`、`reader-mobile-editing.test.mjs` 共 21 项 Chromium/WebKit 检查：实际 live/保存 SVG 自交像素、nonzero 命中/导出、同笔和异笔透明度、无 compatibility click 的 pen 设置、旋转/倾斜悬停、工具栏保存期间无 disabled 切换，以及现有移动端编辑流程。
- 仍需真实 iPad Safari/PWA 对照 Apple Books 验收：连续书写与交叉、设置笔触、不同旋转角度下的悬停和落笔，以及工具栏稳定性。合成 pen 事件不会证明设备是否提供 `twist`。
