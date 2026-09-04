# CI 用量与检查范围

GitHub Actions 按每个 job 的执行分钟计量，分别向上取整；并行 job 的用量会累加，排队等待不等于 runner 执行时间。私有仓库共享所属账号的月额度。套餐、余额和付费预算以 GitHub Billing 为准，不能用工作流次数推断余额。

## 触发与取消

- PR 更新会触发 CI；同一 PR 新运行取消旧运行，不影响其他 PR。
- `main` push 仍验证合并结果。每次 push 的工作流并发组独立，生产部署维持原有串行组，不取消正在进行的迁移/部署。
- `verify` 始终执行 CI 范围回归测试和变更分类，不使用会让 required check 长期 pending 的顶层 `paths-ignore`。
- 仅根目录 `README.md`、`CONTEXT.md`、`AGENTS.md` 和 `docs/**/*.md` 的修改，执行 `git diff --check` 后完成 `verify`，不安装依赖、不运行浏览器、不部署。
- 任意其他路径、空 diff、未知事件、缺少历史或无法确定范围，都运行完整门禁。PR 比较共同祖先到当前合并提交；push 比较事件的 `before` 到当前提交，覆盖一次 push 的所有提交。禁用 rename 检测以检查新旧两个路径，避免把代码改名为文档后漏检；本地 Git diff 没有 GitHub 顶层路径过滤的 300 文件限制。

文档路径是保守白名单。如果未来运行时代码或构建开始读取其中的 Markdown，应先从白名单移除相关路径。轻量检查只证明补丁格式与分类规则通过，不代表文档内容事实已经自动审查。

## 完整门禁与构建

完整 CI 保留 lint、typecheck、客户端、Worker、PWA 更新、加载性能、视觉报告、迁移和生产构建的全部检查。

PWA 更新测试必须分别构建 `pwa-e2e-first`、`pwa-e2e-second`，验证真实 Service Worker 更新。随后 CI 构建当前提交的正式版本，再直接运行 `node scripts/measure-loading-performance.mjs` 检查该产物。因此完整 verify 从四次构建降为三次；不能直接测量或发布 PWA 测试留下的合成版本。

单独使用 `npm run test:loading-performance` 仍会先构建，避免本地误用旧产物。`npm run check` 包含新增的 `npm run test:ci`；`npm run check:full` 继续聚合 `check`、PWA 更新与加载性能，覆盖完整 CI 集合。CI 中保留独立步骤以定位耗时。部署 job 仍自行安装并构建当前提交；暂不为节省一次短构建引入跨 job 产物传输与存储。

## 安装网络请求

CI 使用 `npm ci --prefer-offline --no-audit --no-fund`：优先复用已有 npm 下载缓存，缺失包仍会下载；保留 lockfile 一致性、包完整性和安装失败。`--no-audit` 移除安装附带的漏洞报告请求，`--no-fund` 仅关闭资助信息；这不替代独立的依赖安全审查，也没有删除原有独立安全门禁（当前并无此门禁）。本地默认 npm 配置不变。

2026-09-04 的历史 CI 多次在安装步骤耗时约 303–306 秒，正常约 15–20 秒。已有日志不足以确认是 audit、下载还是安装脚本阻塞。一次本地带时序的普通安装用时 11.5 秒，其中 audit 请求约 2.75 秒；这证明请求存在，不能证明历史 5 分钟停顿的根因。此次移除可避免的网络请求，不宣称完全消除所有网络长尾。

同一 worktree 随后的优化安装用时 11.35 秒，普通安装为 11.52 秒；两次都成功，差值不足以证明稳定加速。可确定的收益是取消旧运行、文档轻量路径及减少一次构建，安装长尾仍需实际 CI 记录判断。

## 验证与测量

`npm run test:ci` 在临时 Git 仓库验证文档/混合改动、多提交 push、删除、改名、超过 300 文件及历史缺失。真实 PR 的 Actions 页面用于核对步骤与耗时；文档范围和并发取消还应分别检查实际分支/运行结果。

基线调查：9 月 1–4 日取样时 77 次运行中 73 次结束，job 实际执行合计约 398 分钟，逐 job 向上取整后约 456 分钟。它只描述该仓库当时的运行记录，不包含其他仓库或未结束运行，也不是账单余额。

参考：[GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、[并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[npm ci 参数](https://docs.npmjs.com/cli/v11/commands/npm-ci/)。
