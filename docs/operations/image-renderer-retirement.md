# #156 图片渲染资源退役

本页是生产操作交接，不是执行记录。本次代码清理没有删除任何远端资源；以下名称来自原仓库部署配置，执行前须只读核实实际资源及共享使用者。

## 代码与验证边界

PDF 上传验证在 `worker/scores/pdf-validation.ts`，使用 `unpdf`，不依赖专属 PDFium 服务。原 `renderer/**` 只提供图片派生及其样本验证，已整体删除。保留 PDF codec WASM、解码器脚本与精确产物校验，也保留产品图片和审查证据。

- 删除 `npm run test:renderer`；`check:full` 仍运行 PWA、常规检查和加载测量。
- `startViteServer({ … })` 删除 `rendererOrigin` 参数，不再注入 `PDF_RENDERER_URL` / `PDF_RENDERER_SECRET`；其他参数和返回值不变。浏览器 fixture 必须同步删除该参数及 native-renderer helper。
- CI scope 删除 `renderer` 输出；现有 `verify` required check、失败/取消/意外跳过拦截保留。
- `release-artifact.mjs seal|verify SHA` 命令不变，封存集合移除 renderer，仍包含 dist、migrations、wrangler.jsonc、package-lock.json。新旧封存集合不同，不能用新验证脚本直接验证旧 renderer 包。
- 移除 Python/pip/Docker renderer 门禁、Google 部署身份与 Cloud Run 步骤；不改变 pdfjs-dist 依赖版本。

采用 legacy 单路径不附带性能推测。Safari 17.5 真机尚未验证，不能用桌面自动化代替目标设备/PWA、笔与排练证据。

## 生产退役顺序

1. 记录当前 Worker 版本、D1 恢复点、旧 release artifact、Cloud Run revision/镜像 digest、队列积压和消费者，确认恢复窗口及负责人。先停止旧发布任务，避免旧 CI 重建服务或重新绑定队列。
2. 发布完整的 #156 客户端/Worker/迁移组合，确认不再产生图片任务，不再访问图片 API，PDF 打开、下载、离线重开、权限与笔记同步通过。校验 `/api/health`、`/build.json` 与目标 SHA；真实 Safari 17.5 验收单列，不提前写成通过。
3. 确认 `same-page-images` 的生产者/消费者均已解绑，检查在途任务、积压及可能的死信配置，记录任务处置后再退役队列。解绑不会自动删除队列；不要丢弃尚未确认归属的任务。确认 token 无其他 Queue 用途后再移除其 Queues Write 权限。
4. 确认没有旧 Worker 或其他调用者依赖服务，恢复窗口结束后退役 GCP 项目 `same-page-clyapps`、区域 `us-central1` 中的 `same-page-renderer` Cloud Run 服务。仅处理专属服务，不直接删除整个项目。
5. 清理 GitHub Actions 的 `PDF_RENDERER_SECRET`、`GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`，及 Worker 的 `PDF_RENDERER_SECRET`。退役 Secret Manager 的 `same-page-renderer-signing`、专属运行身份 `same-page-renderer`、部署身份 `same-page-deployer` 及其 IAM grants；核实 WIF provider `same-page` 无其他调用方后移除，只有 pool `github-actions` 无其他使用者时才能删除 pool。不要输出密钥值。
6. 确认无需旧镜像恢复后清理同区域 Artifact Registry 仓库 `same-page-renderer` 及镜像，按保留规则处理相关日志。服务停止不代表镜像存储费用停止。
7. 旧 R2 页面派生对象和 D1 图片状态按协调后的迁移/清理方案处置：先只读列出并确认专属前缀和引用，不能删除原 PDF、产品图片或整个 scores bucket。保留 PDF 版本、笔记、草稿和恢复规则。不得改写历史 D1 migration 或 wrangler 中两条 Durable Object migration。

完成后记录实际操作时间、资源标识与验证结果；旧包回滚需要恢复匹配的旧脚本、队列、凭据及服务，不能把仅回滚 Worker 当作完整恢复。
