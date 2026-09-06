# WebKit 连续编辑 CI 偶发失败调查

调查日期：2026-09-06。基线：`ace3b3d8af795aad8551a1bcdc484978bc1b000b`。

## 结论

原测试等待编辑工具栏出现后，立即读取可见页面数量。Linux WebKit 的一次失败现场显示：编辑状态和隐藏属性已经写入 DOM，但第二页的计算样式仍为 `visible`；两个 animation frame 后变为 `hidden`，页面几何位置不变。工具栏出现不足以证明页面隐藏完成。

这解释了此次 CI 的间歇性失败。证据没有证明 WebKit 内部的具体缺陷，也没有证明真实设备上出现可见闪烁：该现场第二页的 y=1187，位于 700px 高的视口之外。

## 核实已有结果

- [PR #164](https://github.com/itscly2026/same-page/pull/164) 的 head `4273a25` 与合并提交 `7438a4f` 的 Git tree 相同。PR [run 34030527519](https://github.com/itscly2026/same-page/actions/runs/34030527519) 首次失败、同 SHA 重试成功；[main run 34031155218](https://github.com/itscly2026/same-page/actions/runs/34031155218) 又在同一 WebKit 场景失败。
- 后续 [PR #167](https://github.com/itscly2026/same-page/pull/167) 的 `2c82713` 包含 `7438a4f`，[run 34031534537](https://github.com/itscly2026/same-page/actions/runs/34031534537) 的同一场景通过，合并后的 [main run 34031789344](https://github.com/itscly2026/same-page/actions/runs/34031789344) 也通过。

## Linux 复现与对照

使用隔离分支、GitHub Actions ubuntu-latest、Node 24、锁文件依赖及 Playwright WebKit。复现只使用合成 reader fixture，不触发部署。

| 验证 | 结果 |
| --- | --- |
| [原断言重复 20 次](https://github.com/itscly2026/same-page/actions/runs/34032357822)，诊断提交 `1e09ff7` | 第一次失败（2 != 1），后 19 次通过 |
| [可重试断言重复 20 次](https://github.com/itscly2026/same-page/actions/runs/34032658606)，诊断提交 `d9eecda` | 20/20 通过 |
| 同一对照 run 中强制隐藏页 `visibility: visible !important` | 3 秒后失败，Expected: 1 / Received: 2，保留对持续错误的检测 |

失败现场的关键状态（artifact `webkit-0.json` 和 trace）：

| 状态 | 原断言失败后立即采样 | 两个 animation frame 后 |
| --- | --- | --- |
| reader `data-editing` | `true` | `true` |
| 第二页 `data-edit-hidden` / `inert` | `true` / 存在 | `true` / 存在 |
| 第二页及纸面的计算 `visibility` | `visible` | `hidden` |
| 第二页纸面 x / y / width | -90 / 1187 / 1042.5 | -90 / 1187 / 1042.5 |

Trace 中工具栏等待结束于 17052.869ms；原页面数量读取在 17057.121–17066.713ms 返回两页；两个 frame 的等待在 17382.995ms 完成，随后采样为隐藏。时间仅描述该样本，不作为固定延时依据。

诊断 workflow 和环境开关已从最终改动移除；可在以上诊断提交中查看完整复现步骤。Actions artifact 保留期为 7 天，故关键结论与状态记录在此文档。

## 修正与验证边界

连续编辑测试改为 `expect(visiblePages).toHaveCount(1, { timeout: 3000 })`，等待所需的页面锁定状态。保留原有数量、缩放、位置、滚轮锁定和退出编辑检查，不使用固定 sleep。失败时保存编辑属性、计算样式、几何信息和截图到 CI 已收集的 `artifacts/verification/reader-immersive/`。

本次改动限于测试及诊断资料，没有修改产品编辑流程。20 次成功不能证明永不失败；负对照证明这项等待仍会拒绝第二页持续可见的回归。真实设备的交互体验仍需独立验证。

本地验证命令：

```sh
node --test visual-report/reader-immersive.test.mjs
npm run lint
```
