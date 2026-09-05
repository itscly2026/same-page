# CI 用量与检查范围

GitHub Actions 按每个 job 的执行分钟计量，分别向上取整；并行 job 的用量会累加，排队等待不等于 runner 执行时间。私有仓库共享所属账号的月额度。套餐、余额和付费预算以 GitHub Billing 为准，不能用工作流次数推断余额。

## 触发与取消

- PR 更新会触发 CI；同一 PR 新运行取消旧运行，不影响其他 PR。
- `main` push 仍验证合并结果。每次 push 的工作流并发组独立，生产部署维持原有串行组，不取消正在进行的迁移/部署。
- `verify` 始终执行 CI 范围回归测试和变更分类，不使用会让 required check 长期 pending 的顶层 `paths-ignore`。
- 仅根目录 `README.md`、`CONTEXT.md`、`AGENTS.md` 和 `docs/**/*.md` 的修改，执行 `git diff --check` 后完成 `verify`，不安装依赖、不运行浏览器、不部署。
- 其他改动始终运行 lint 和 typecheck，再按受影响区域选择昂贵步骤。空 diff、未知路径、未知事件、缺少历史或无法确定范围时回退完整门禁。PR 比较共同祖先到当前合并提交；push 比较事件的 `before` 到当前提交，覆盖一次 push 的所有提交。禁用 rename 检测以检查新旧两个路径，避免把代码改名为文档后漏检；本地 Git diff 没有 GitHub 顶层路径过滤的 300 文件限制。

文档路径是保守白名单。如果未来运行时代码或构建开始读取其中的 Markdown，应先从白名单移除相关路径。轻量检查只证明补丁格式与分类规则通过，不代表文档内容事实已经自动审查。

## 按变更范围选择门禁

路径分类取一次变更中所有文件的并集：

| 变更区域 | 额外门禁 |
| --- | --- |
| 客户端生产代码 | 客户端测试、视觉测试、加载性能、生产构建；真实存储 smoke；只有 PWA 入口与更新逻辑再运行 PWA 交接 |
| Worker 生产代码 | Worker 测试、生产构建、真实存储 smoke |
| 客户端或 Worker 测试 | 只运行对应测试，不构建或部署 |
| 共享运行时代码 | 客户端、Worker、视觉、加载性能和生产构建 |
| D1 migration | Worker、迁移、生产构建与真实存储 smoke |
| 视觉报告代码 | 视觉、加载性能、生产构建、真实存储 smoke |
| 依赖、Vite、Wrangler 或未知路径 | 完整门禁 |

只有影响生产客户端、Worker、共享代码、静态资源或 migration 的 `main` push 才进入 deploy job。测试、CI 配置和验证脚本本身不会触发生产部署。分类器无法识别的新路径必须先按完整门禁处理，再显式加入规则。

浏览器在视觉、PWA、加载性能或真实存储 smoke 被选中时安装。共享或尚未分类的验证脚本保守运行全部验证门禁，但不自动部署；已知专用脚本仅选择其消费者。文档与验证脚本混合改动仍不触发部署。客户端与 Worker 中不依赖 jsdom/workerd 的纯逻辑测试分别使用 Node 环境，避免为小测试重复启动重型运行时。视觉测试最多并发两个文件，并只保留 Chromium/WebKit、关键响应式边界和代表性身份组合；身份授权的全排列由组件测试覆盖。迁移测试仍从空数据库执行全部 migration 和断言，但会把连续 migration 与只读断言批量交给同一个 Wrangler 进程，减少 CLI 冷启动。

## 完整门禁与构建

依赖、构建配置或未知路径仍保留 lint、typecheck、客户端、Worker、PWA 更新、加载性能、视觉、迁移、生产构建及真实存储 smoke 的全部检查。

PWA 更新测试必须分别构建 `pwa-e2e-first`、`pwa-e2e-second`，验证真实 Service Worker 更新。随后 CI 构建当前提交的正式版本，再直接运行 `node scripts/measure-loading-performance.mjs` 检查该产物。因此完整 verify 从四次构建降为三次；不能直接测量或发布 PWA 测试留下的合成版本。

单独使用 `npm run test:loading-performance` 仍会先构建，避免本地误用旧产物。`npm run check` 包含 `npm run test:ci`；`npm run check:full` 按 PWA 更新、`check`、加载性能顺序执行，是所有按范围 CI 路径的本地超集。CI 中保留独立步骤以定位耗时。部署 job 下载本次 verify 上传的 `release-<SHA>`，校验 SHA256 清单后直接部署，不再构建。清单、迁移、运行配置、lockfile 与完整 dist 同包传输；GitHub artifact ID、digest 和源码 SHA 写入 step summary。保留 14 天，过期需重跑验证生成新包，不能改为现场构建后直接发布。

## 安装网络请求

CI 使用 `npm ci --prefer-offline --no-audit --no-fund`：优先复用已有 npm 下载缓存，缺失包仍会下载；保留 lockfile 一致性、包完整性和安装失败。`--no-audit` 移除安装附带的漏洞报告请求，`--no-fund` 仅关闭资助信息；这不替代独立的依赖安全审查，也没有删除原有独立安全门禁（当前并无此门禁）。本地默认 npm 配置不变。

2026-09-04 的历史 CI 多次在安装步骤耗时约 303–306 秒，正常约 15–20 秒。已有日志不足以确认是 audit、下载还是安装脚本阻塞。一次本地带时序的普通安装用时 11.5 秒，其中 audit 请求约 2.75 秒；这证明请求存在，不能证明历史 5 分钟停顿的根因。此次移除可避免的网络请求，不宣称完全消除所有网络长尾。

同一 worktree 随后的优化安装用时 11.35 秒，普通安装为 11.52 秒；两次都成功，差值不足以证明稳定加速。可确定的收益是取消旧运行、文档轻量路径及减少一次构建，安装长尾仍需实际 CI 记录判断。

## 验证与测量

`npm run test:ci` 在临时 Git 仓库验证文档/混合改动、多提交 push、删除、改名、超过 300 文件及历史缺失。真实 PR 的 Actions 页面用于核对步骤与耗时；文档范围和并发取消还应分别检查实际分支/运行结果。

本地优化基线使用同一机器、同一 worktree 测量：迁移测试由约 116 秒降至约 51 秒，Worker 测试由约 57 秒降至约 21 秒，视觉测试由串行约 124 秒降至两次约 49–50 秒。本地 `npm run check:full` 最终用时约 213 秒。GitHub runner 的实际收益以合并后的 Actions 记录为准，不能直接把本地数据当作计费承诺。

基线调查：9 月 1–4 日取样时 77 次运行中 73 次结束，job 实际执行合计约 398 分钟，逐 job 向上取整后约 456 分钟。它只描述该仓库当时的运行记录，不包含其他仓库或未结束运行，也不是账单余额。

参考：[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[npm ci 参数](https://docs.npmjs.com/cli/v11/commands/npm-ci/)。

## 并发发布与测试资源

身份和资源生命周期见 [交付契约](delivery-contract.md)。生产锁从准入持续到线上验收，不因新 push 取消。`production-release` 的 GitHub Deployment 记录在迁移前创建；旧祖先运行跳过，同 SHA 可重试，未知历史或分叉失败。判断依据是上次发布尝试，不是最新 main，因此文档提交不会造成漏发。GitHub 自带 job environment 的 queued 记录不参与判断。

每次自动化 Vite dev/preview 都分配临时持久化目录、配置、缓存和端口；preview 使用隔离的构建配置副本，应用产物字节不变。只使用合成认证参数，测试不读取开发 `.dev.vars`。服务身份标记防止误连占用端口的其他进程；启动失败返回原始退出原因，停止时清理整个进程组，包括启动器先退出的后代。正常结束、启动失败和 SIGINT/SIGTERM 会清理拥有的目录；SIGKILL/断电无法执行清理，遗留目录位于系统临时目录，可在确认所属进程退出后删除，不应清空日常开发状态。

`npm run test:smoke` 要求先 `npm run build`，通过 `browser-tests/storage-fixture.mjs` 为每次调用准备独立本地 D1/R2。准备进程释放后才启动 preview。场景使用真实生产 API，验证访客准入、R2 PDF 字节一致、产品下载完成、持久化 Chromium 关闭重开后断网阅读。共享图层是合成 fixture，没有 API 拦截、预填 IndexedDB 或测试 HTTP 后门。#135/#136 可复用该生命周期添加产品回归；认证提供方和实机验收仍由 #9/#39 跟踪。

测试阶段与源码身份写入 `artifacts/verification/`，CI 无论成功失败都会保留已有合成测试证据；启动失败仍可从对应 Actions 步骤读取原始日志。不得向该目录放入生产会话、私人谱面或凭据。浏览器测试保留 `--test-concurrency=2`，没有自动用例重试。

#134 的本地重复运行、历史 Actions 基线及尚待上线的证据见 [实施验证记录](verification-134.md)。
