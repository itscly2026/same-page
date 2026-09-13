# #296 荧光笔阅读崩溃验证

## 证据与边界

用户报告 iPad 正常阅读翻页进入「乐谱阅读器加载失败，请重试」。线上桌面控制台捕获 `RangeError: Maximum call stack size exceeded`，`polygon-clipping` 的 `RingOut.isExteriorRing` 反复递归。用户提交的界面故障诊断没有 records；旧 RouteErrorBoundary 只切换 fallback，没有记录异常。

在 a31e43d 上，以 seed=1 的 40 点斜头荧光笔调用真实 `inkSvgPaths`，稳定复现同一堆栈；只换回 #278 前 highlighter-geometry 即通过，恢复当前版本再次失败。进一步逐点删除到 7 点，任何单点删除均不能再复现，固化为 `src/test/highlighter-fixture.ts`。这是几何缺陷的受控复现，不是 iPad 原始笔迹或实机验收。

## 选择

保留既有覆盖模型，使用固定精度 Clipper2（`clipper2-ts@2.0.1-18`，Boost Software License 1.0）替换 `polygon-clipping`。每次运算都在 1e-8 页宽网格上量化，保留孔洞及嵌套岛屿；没有修改原始 points、持久化格式或普通笔算法。浮点拓扑退化是堆栈及对照支持的解释，没有把裁剪库内部缺陷宣称为已完成上游修复。

参考：[Clipper2 官方项目列出的 TypeScript port](https://github.com/AngusJohnson/Clipper2)、[该 port 的精度、测试和许可说明](https://github.com/countertype/clipper2-ts)。polyclip-ts 仍采用同族 sweep 算法；本次未完成它的性能对照，不把它标为失败方案。

没有选择整体栅格化：无须新增分辨率、像素缓存和渲染生命周期。现有 PDF 导出本就把笔记覆盖层栅格化，但仍与 SVG/命中检测共用覆盖几何。逐段透明蒙版/路径合成理论上可避免全局并集，但相邻边缘抗锯齿接缝需要额外证明，没有交付未经验证的替代渲染。

仅替换运算库不足以解决计算复杂度。显示采样采用 RDP，最大中线偏差为页宽 1e-4（4096px 导出下小于 0.5px）；在简化前去除不改变笔头姿态的停顿重复点，在折返点、笔头旋转边界分段。原始数据不简化。该误差上限约束的是中线，不宣称逐像素完全相同；极小覆盖边缘仍可能有亚像素差异。

每条笔迹累计提交的裁剪顶点不超过 500,000，超过或发生异常使用 uniform 中线轮廓（不继续裁剪），明确标为「此笔迹已简化显示」。保留原始笔迹，可重新打开/后续版本重算。屏幕、导出及命中共享该降级几何与 nonzero fill rule。降级不等于叠色效果通过，不把降级作为原始回归样本的合格结果。

几何和 SVG path 以不可变 payload 为弱引用缓存，仅保留最近 intrinsic aspect ratio；失败结果也缓存。新内容/不同页面几何会重新计算，不建立持有用户笔记的全局强引用缓存。渲染采样可能随新增点调整，所以不复用旧算法的前缀缓存。

## 性能探针

macOS 桌面单次测量，Node 25.9.0，未预热；不是 iPad 耗时或 CI SLA。输入为 `x=.1+.8*i/(n-1), y=.5+sin(20*i/(n-1))*.1`，宽度 .012，页面比例 .714。

| 5000 点 | 仅换 Clipper2 | 简化 + 运算预算 + 缓存，首次 |
| --- | ---: | ---: |
| 圆头 | 23070 ms | 37 ms |
| 斜头 | 18658 ms | 31 ms |

永久测试覆盖 5000 点样本在预算内完成且不降级，并检查重复读取复用 path。没有把易受机器负载影响的毫秒阈值写进单元测试。高复杂度 5000 次折返样本验证预算触发、保留数据、降级仍可绘制；这些限制不构成所有 iPad 上的帧率保证。

## 检查与上线

- `npm run test:unit -- --maxWorkers=2`：包含最小样本、孔洞/岛屿、停顿/折返/旋转、5000 点、降级隔离与隐私检查。
- `node --test visual-report/highlighter-regression.test.mjs`：Chromium/WebKit，真实 reader 读取带问题笔迹的第二页，左右区域点击往返四次，无错误页、无 pageerror、无降级。
- `node --test visual-report/highlighter-nib.test.mjs`：圆头/斜头叠色的 SVG 与导出 PDF 像素检查，普通笔自交及命中检测。
- RouteErrorBoundary 捕获异常只保存白名单类型、固定步骤，不保存 message、stack、坐标、谱名或凭据。旧客户端仍可提交旧诊断；新枚举须随服务端 schema 先上线，之后发布客户端。
- 本分支不修改 Cookie/session、笔记数据、数据库、IndexedDB schema 或 outbox；登录过期是独立问题。
- 合并/部署及 iPad 原谱、Pencil/真实双指交互验收必须单独记录。此 PR 不宣称这些已完成。
