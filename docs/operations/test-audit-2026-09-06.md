# 测试与 CI 审查 · 2026-09-06

审查基线：`4885eba`。目的：缩短 PR 反馈周期，删除低价值测试，保留能发现产品错误的覆盖。TDD 来源不是删除依据，测试数量也不是目标指标。

## 实际瓶颈

| GitHub 成功运行 | verify 总耗时 | client | Worker | 浏览器安装 | 视觉 | storage smoke |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [34001740053](https://github.com/itscly2026/same-page/actions/runs/34001740053) | 740 s | 86 s | 62 s | 53 s | 229 s | 100 s |
| [34001812033](https://github.com/itscly2026/same-page/actions/runs/34001812033) | 640 s | 69 s | 53 s | 43 s | 206 s | 90 s |

依赖安装分别只有 18/13 秒。第一个运行的实际 diff 包含 `docs/operations/issue-142/*.png` 和 `evidence.json`，分类器将它们当作未知路径，错误地扩大成包括 PWA、迁移的完整检查。视觉测试的多个文件又各自启动 Vite/workerd、反复编译客户端。串行工作流将这些成本相加。

## 删除与收敛

删除 21 个独立用例，以及仍保留用例中的文案、class、SVG 结构断言。未设置 skip/todo 或重试，也没有关闭剩余断言。

| 原测试/断言 | 决定与理由 | 保留的验证位置 |
| --- | --- | --- |
| `reader-style-contract.test.ts`，5 项 | 删除。正则跨 CSS 规则匹配颜色、class、属性顺序，既会误报也不能证明渲染正确 | `reader-mobile-editing`、`reader-canvas-layering`、`reader-text-layout` 浏览器测试；组件翻页和手势行为 |
| `reader-layouts.test.ts`，2 项 | 删除。只确认几个 min/max 样例及页宽加 14，不证明页面实际可见或能翻页 | `reader-layout-canvas`、`use-paged-reader`、`use-reader-gestures`、真实 reader 浏览器测试 |
| `text-editor-layout.test.ts`，1 项 | 删除。锁定内部留白计算得出 76px | WebKit 中真实 textarea 的多行、长文、缩小视口、滚动和光标断言 |
| `annotation-overlay` 假 scrollHeight 的 2 项 | 删除。把自己提供的高度再断言回去，浏览器测试已经覆盖真实几何 | 同上；保留组件中的文本提交、取消、写入失败、Pencil 激活、拖放等行为 |
| `app` 隐私页固定文案 1 项；营销段落断言 | 删除复制文案的用例/断言。保留核心品牌与语言标记、进入云盘和登录行为 | `responsive-navigation` 实际键盘进入隐私/诊断页；隐私规则由 Worker/本地存储测试负责 |
| `loading-performance` 缓存分类回填 1 项 | 删除相同输入输出枚举遍历 | `reader-reopen-tracker` 验证身份、乐谱及时间如何决定 cold/warm/reopen |
| `annotations` 旧 scoreColorOverride 字段剥离 1 项 | 删除对 Zod 默认剥离额外属性的断言 | 保留订阅请求 schema、颜色/订阅优先级及 Worker 路由领域规则 |
| `social-providers` 配置形状 1 项 | 删除和 Worker OAuth 流程重复的配置对象断言 | 保留缺失凭据时禁止启用；`auth-flow` 验证真实重定向、scope、state 与恢复 |
| `visual-report` 场景 ID 清单、fixture 常量等 7 项 | 删除对测试数据自证的断言，fixture 错误在实际消费者失败 | 保留未知请求拒绝外发、报告 HTML 转义两个基础设施行为测试 |
| reader、join-code、overlay 中 class/SVG/装饰槽位结构 | 删除实现结构断言，保留用户可见状态、输入、可访问语义、操作结果 | 实际布局尺寸与组件交互测试 |
| D1 批量操作精确 `11 SQL / 6 round trips` | 改为比较 1/100 个对象的 SQL/往返增长是否有界，仍验证所有操作成功 | 原真实 D1 批量流程；可发现 N+1，允许合法调整查询计划 |

视觉排列同时减少：iPad 8 个商品预设缩成两个有区别的移动视口/方向；桌面宽度扫描与 200% 文本仍保留。reader 控件从两个引擎各 6 个宽度改为共 7 个组合，最窄 320px 两个引擎都运行。图层偏好/管理布局每种宽高只选一个引擎，两种引擎仍分别完整执行失败、重试、订阅与编辑隔离流程。首页真实溢出回归及全部浏览器存储用例保留。

## 保留边界的全套审查结论

| 测试组 | 保留原因 |
| --- | --- |
| Worker auth/principal/security、邮件发送、限流清理 | OAuth state/origin、已验证邮箱合并、会话撤销、跨云盘权限、OTP/邀请码滥用均是独立风险；不是通用库的重复单测 |
| Worker annotations/scores/lifecycle/scheduled cleanup | OCC、幂等、失权、个人层私密、不可变 PDF、候选版本、回滚、配额、到期边界与清理会导致数据泄漏或损失 |
| client local-database/local-workspace/logout/offline | 用户切换、旧数据清理、损坏 Blob、并发激活和原子回滚；真实本地状态覆盖不能用 happy-path E2E 替代 |
| local-annotations/sync/outbox recovery | 未确认操作、丢失响应、重启、undo/redo、版本零删除、多标签锁和被撤销编辑权都是不同因果路径 |
| reader-page/session/document-cache/gestures/pager/layout-canvas | 异步旧结果、PDF 版本不匹配、渲染交接、连续输入、取消/重试及身份切换；虽然 fixture 长，但断言针对实际状态机边界 |
| app/home-entry/auth-page/user-lifecycle-page | 深链接意图、公开体验与成员关系分离、草稿隔离、认证完成与恢复顺序需要组件集成覆盖 |
| upload/offline-score/pdf-version/invite-code dialogs | 串行队列、不确定结果禁止盲重试、仅校验完成才显示离线、候选明确确认、保留码恢复等产品行为 |
| diagnostics 客户端/Worker/CLI | 凭据与私人内容的脱敏、身份代际、保留期、幂等提交和丢失回执；组件、路由和浏览器分别覆盖自己的边界 |
| PWA update、browser-tests 全部文件 | 真 Service Worker 交接、生产构建与真实 D1/R2、浏览器关闭重开断网、原生图片转换、两浏览器诊断提交；这些和 mocked visual fixture 证据不同 |
| scripts CI/release/deployment/process/migration/precache/provision | 错误放行发布、错误版本被验证、测试误连服务、后代进程遗留、schema 数据损坏、预缓存遗漏和输出凭据；保留防错行为测试 |
| shared annotations、performance 分类/预算/报告 | 领域优先级、隐私安全的测量记录、基于中位数的统计与预算失败信号；不以零耗时为由删除规则测试 |

5 个文件改名为 `*.node.test.ts`：pwa-navigation、preview-guest-session、diagnostics、reader-reopen-tracker、reader-sync-status。它们改由 Node 执行，不再加载 jsdom/React/数据库 cleanup。PDF document cache 使用真实 `window` 计时器，继续留在 jsdom，没有为迁移测试引入生产兼容层。删除 CSS 源码测试后，离线测试直接声明自己需要的 Node 类型，不再偶然依赖另一个测试文件的全局类型引用。

## 验证记录

- 新工作流通过 actionlint 1.7.12。直接执行 YAML 中的汇总脚本，检查全部成功、选中阶段失败/取消/跳过、scope 失败、纯文档、仅测试改动等 7 种结果，均正确放行或拒绝。
- 范围测试从 14 项变为 16 项，新增真实截图混合 reader 改动和原生渲染器范围回归。继续覆盖删除、改名、特殊路径、大于 300 文件、共同祖先与缺少历史。
- 客户端/Node 用例从 355 项变为 342 项，全部通过；Worker 从 83 项变为 82 项，全部通过；视觉从 36 项变为 29 项（均为删除 fixture 自证，实际布局场景另做收敛）。
- 第一次旧版全套运行在视觉 teardown 出现一次既有 `kill EPERM`，因此没有获得可信的完整成功时间基线。旧视觉阶段约 100 秒；新版独立视觉运行 65.9 秒、全套中的视觉 71.2 秒，均 29/29 通过。不能把一次失败基线与本地波动当成稳定 CI 加速比例。
- 对保留测试进行了两次临时错误注入：无服务端确认也显示已同步、切换用户后接纳旧诊断，均被对应 Node 测试检出。源码恢复后相关测试再次通过，未保留任何故意错误。
- 原生 PDF 回归在 macOS/Python 独立虚拟环境执行；Linux Docker 无网络打包证明以实际 PR CI 为准，不能用 macOS 结果代替。

`npm run check:full` 完整通过，用时 238.02 秒，包含 16 项 CI 范围测试、342 项客户端/Node、82 项 Worker、29 项视觉、7 项浏览器 smoke，以及原生渲染、PWA 交接、迁移、build/precache、加载预算。真实 PR CI 结果在本次交付时补充。自动化浏览器结果始终不是 iPad/iPhone/Pencil/弱网实机验收。

## 后续新增测试标准

新增前先说明：什么用户行为或不变量会出错、哪一条现有测试不能发现它、哪个最低成本层可以可靠检测。修 bug 的回归测试应能在错误实现上失败；不要求为了 TDD 留下每一个开发阶段的测试。不要用整段文案、CSS 正则、class 名、mock 返回值或截图数量替代行为。布局需要真实浏览器测量；数据安全需要失败、竞态和持久化边界。删除测试时留下其风险已覆盖或不再存在的理由，不按百分比机械裁减。
