# CI 检查与开发反馈

PR 更新触发按变更范围选择的检查，同一 PR 新运行取消旧运行。`main` push 验证实际合并结果；生产部署继续串行，迁移和部署不被后续 push 中断。原有 required check 名称 `verify` 保持不变。

## 流程

`scope` 不安装依赖：运行 CI 范围回归测试，然后比较完整 Git diff。三个验证 job 同时启动，各自只执行选中的步骤：

| Job | 职责 |
| --- | --- |
| `checks` | lint、typecheck、Node/组件测试、Worker 测试、迁移回归 |
| `visual` | Chromium/WebKit 中的布局与交互回归 |
| `integration` | 必要的原生渲染器验证、PWA 交接、生产构建、加载预算、真实 Worker/D1/R2 浏览器流程 |
| `verify` | 等待以上全部结束；被选中的 job 必须成功，未选中的必须为 skipped；失败、取消、意外跳过均不能通过 |

部署仅在 `verify` 成功且本次 main 变更需要发布时运行。并行降低等待时间，但重复的 runner 启动和安装可能增加总执行分钟；不是降低账单的承诺。保留三个实际工作 job，避免为每个小测试创建 runner。

## 范围选择

不使用顶层 `paths-ignore`，避免 required check 长期 pending。PR 比较当前合并提交与 base 的共同祖先；push 比较事件 `before` 到当前提交，包含一次 push 的所有提交。禁用 rename 检测以同时检查新旧路径，NUL 分隔支持特殊文件名，不受 GitHub 顶层过滤的 300 文件限制。

| 改动 | 选中的检查（非文档改动始终 lint/typecheck） |
| --- | --- |
| `README.md`、`CONTEXT.md`、`AGENTS.md`、`docs/**/*.md` | diff whitespace |
| `docs/operations/` 内 PNG/JPEG/WebP、子目录 `evidence.json` | 同上；这些审查证据不被应用或构建读取 |
| 客户端生产代码 | 客户端、视觉、构建、加载预算、真实存储 smoke |
| PWA 入口/导航/更新提示 | 客户端路径加真实 PWA 双版本交接 |
| Worker 生产代码 | Worker、构建、真实存储 smoke |
| 共享运行时代码 | 客户端、Worker、视觉、构建、加载预算、smoke |
| 客户端/Worker 测试 | 对应测试，不构建、不部署 |
| D1 migration | Worker、迁移、构建、smoke |
| 视觉测试文件、视觉 setup | 视觉测试，不构建、不部署 |
| 共享视觉 fixture/report 代码 | 视觉、构建、加载预算、smoke |
| `renderer/` | 原生验证、Linux 容器无网络验证、构建、smoke |
| 依赖、构建配置或未知路径 | 完整验证 |

多个路径取检查的并集。未知事件、缺失历史、空 diff、不可识别文件均回退完整验证。文档中的 JS、未知 JSON、运行时图片仍不属于轻量白名单。如果将来运行时或构建开始消费审查证据，必须先更新分类器。

共享或未知验证脚本保守运行全部验证，但不自动部署。生产客户端、Worker、共享代码、静态资源、渲染器和 migration 的 main push 才进入部署；CI、测试和验证脚本本身不触发部署。完整规则以 `scripts/ci-scope.mjs` 为准。

## 测试的职责

测试是否保留，以可观察错误及独立覆盖为标准，不以 TDD 来源、用例数量或覆盖率百分比为标准。清理结论与保留风险见 [测试审查记录](test-audit-2026-09-06.md)。

- `npm test`：Node 规则和 jsdom 组件。客户端纯逻辑文件用 `*.node.test.ts` 命名，由 `vitest.node.config.ts` 收集，jsdom 明确排除；不为这些测试启动 DOM、React cleanup 或 IndexedDB setup。
- `npm run test:worker`：纯认证配置/安全逻辑在 Node，真实路由、D1、R2、权限与生命周期在 workerd。保留实际迁移初始化和隔离，不为省时间改成共享可变数据库。
- `npm run test:visual-report`：Node 原生 global setup 只启动一个隔离 Vite dev 服务，最多两个文件并行。各测试仍独立拥有浏览器 context、IndexedDB、API route 和 fixture session；没有重试。直接 `node --test visual-report/<file>.test.mjs` 仍可独立启动服务。
- `npm run test:smoke`：必须先 build。每次 fixture 调用有独立真实 D1/R2，验证生产 API、PDF 字节、下载、浏览器关闭重开后的离线副本、批注并发、图片兼容模式和诊断提交；不改成 API mock。图片流程需要 `renderer/requirements.txt` 的 Python 依赖。

视觉回归保留两种浏览器引擎、最窄视口、关键断点两侧、横竖屏、200% 文本、44px 点击目标和真实内容溢出断言。相同完整流程不重复遍历每个设备商品名；这些都是模拟视口，不代表实机验收。

## 产物与发布

PWA 测试构建 `pwa-e2e-first`、`pwa-e2e-second` 并验证真实 Service Worker 交接。随后重新构建当前源码，再验证加载预算和浏览器 smoke；合成版本不得发布。`npm run test:loading-performance` 单独执行时仍先 build。

仅需部署的 main 运行封存并上传 `release-<SHA>`，PR 不上传不可用于生产的合并测试包。integration 可以先产生包，但 deploy 必须等待汇总 `verify` 成功。部署下载同次运行的产物，校验 SHA256 清单，直接发布而不重建。产物保留 14 天；过期需重新验证生成。visual/integration 分别保留 `artifacts/verification/` 的已有合成证据，失败时也上传，不能放入生产会话或私人内容。

`npm run check` 运行所有常规检查；`npm run check:full` 再包含原生渲染、PWA 更新及加载预算，是本地验证超集。Linux Docker 无网络验证在 CI 单独运行。生产身份、准入与锁见 [交付契约](delivery-contract.md) 和 [发布流程](production-release.md)。

## 本地浏览器检查与视觉报告

首次运行浏览器测试或报告前安装两个引擎；Linux/CI 同时使用 `--with-deps` 安装系统依赖：

```bash
npx playwright install chromium webkit
```

原生渲染和图片 smoke 需要 `renderer/requirements.txt` 的 Python 依赖。完整检查会启动
本地 workerd/Vite、临时 D1 和浏览器，并多次构建；不需要生产凭据，不操作生产数据。
`check:full` 不应与其他构建命令在同一工作目录并行运行，也不生成完整视觉报告。

```bash
npm run visual:report
```

报告直接运行当前生产构建的 React 路由、样式和 PDF.js，以浏览器请求 fixture 提供虚构
身份、云盘和乐谱，不维护另一套页面。每次替换忽略提交的 `artifacts/visual-report/`：
`index.html` 是报告，`screenshots/` 保存 PNG，`manifest.json` 记录 commit、场景与尺寸。

场景和完成条件在 `visual-report/scenarios.mjs` 声明，请求数据由 `visual-report/fixtures.mjs`
统一提供；未知 `/api/*` 请求返回 404，避免访问实际业务数据。报告使用 Chromium，其他
布局门禁同时覆盖 WebKit。iPad 仿真不证明 Safari 工具栏、虚拟键盘、PWA 全屏、安全区或
Apple Pencil 的实机表现，设备验收见 [发布 runbook](production-release.md#人工验收脚本)。

## 安装与性能评估

Node 使用 lockfile 和 npm 下载缓存，安装命令为 `npm ci --prefer-offline --no-audit --no-fund`；原生依赖使用 setup-python 的 pip 缓存。不缓存可变测试数据库，不复用未经本次验证的发布产物。

2026-09-06 两次成功 PR 的 verify 用时 740 秒、640 秒，视觉分别 229/206 秒、storage smoke 100/90 秒、依赖安装 18/13 秒。当前瓶颈是串行关键路径、重复浏览器启动与错误范围放大，不能继续把提速主要归因于 npm 缓存。修改后的真实 Actions 数据与本地验证边界记录在测试审查记录中。

参考：[GitHub jobs 与依赖](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)、[依赖缓存](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching)、[Node 24 全局测试 setup](https://nodejs.org/docs/latest-v24.x/api/test.html#global-setup-and-teardown)、[Vitest 并行](https://v4.vitest.dev/guide/parallelism)。
