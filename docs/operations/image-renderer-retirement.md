# #156 图片渲染资源退役

本页是生产操作交接，不是执行记录。以下名称来自原仓库部署配置，执行前须核实实际资源及共享使用者。发布流程只自动解绑专属旧 consumer，不自动删除队列、消息或 Cloud Run 资源。

## 代码与验证边界

PDF 上传验证在 `worker/scores/pdf-validation.ts`，使用 `unpdf`，不依赖专属 PDFium 服务。原 `renderer/**` 只提供图片派生及其样本验证，已整体删除。保留 PDF codec WASM、解码器脚本与精确产物校验，也保留产品图片和审查证据。

- 删除 `npm run test:renderer`；`check:full` 仍运行 PWA、常规检查和加载测量。
- `startViteServer({ … })` 删除 `rendererOrigin` 参数，不再注入 `PDF_RENDERER_URL` / `PDF_RENDERER_SECRET`；其他参数和返回值不变。浏览器 fixture 必须同步删除该参数及 native-renderer helper。
- CI scope 删除 `renderer` 输出；现有 `verify` required check、失败/取消/意外跳过拦截保留。
- `release-artifact.mjs seal|verify SHA` 命令不变，封存集合移除 renderer，仍包含 dist、migrations、wrangler.jsonc、package-lock.json。新旧封存集合不同，不能用新验证脚本直接验证旧 renderer 包。
- 移除 Python/pip/Docker renderer 门禁、Google 部署身份与 Cloud Run 步骤；不改变 pdfjs-dist 依赖版本。

实际安装的 PDF.js 6.3.289 legacy 未补充 `Promise.withResolvers`；它是当前运行前提。缺失时应明确显示 `engine-unavailable` 并保留原 PDF 下载，能力探针按 [PDF 运行资源说明](../runbooks/pdf-rendering-assets.md#legacy-支持边界) 分开验证，不能宣称 legacy 解决全部 API 缺失。采用 legacy 单路径不附带性能推测。Safari 17.5 真机尚未验证，不能用桌面自动化代替目标设备/PWA、笔与排练证据。

## 生产退役顺序

1. 记录当前 Worker 版本、D1 恢复点、旧 release artifact、Cloud Run revision/镜像 digest、队列积压和消费者，确认恢复窗口及负责人。**合并 #156 前**停止旧发布任务并阻止新的图片任务进入 `same-page-images`；保留旧消费者及 renderer 完成已有任务，排空积压和重试，核实死信处置，并等待全部在途渲染及元数据写入完成。记录队列为空且无活动任务的证据后才允许合并。若无法阻止新任务或无法确认排空，不得进入自动迁移发布；不能先停消费者、留下积压再 drop 表。
2. 在上述排空前提满足后发布完整的 #156 客户端/Worker/迁移组合。**先解绑 consumer，再迁移和发布**：在 production lock、release admission、artifact 校验及 D1 恢复点记录后，CI 执行 `node scripts/retire-image-consumer.mjs`，仅删除 `same-page-images` 中 `script=same-page` 的 Worker consumer，并重新读取确认解绑。队列不存在或已解绑时不写入；权限、网络、响应格式或删除确认失败会阻止后续迁移和发布。脚本不 purge 消息、不删除队列、不处理其他 consumer。Cloudflare 不会因为 Wrangler 配置删除 `queues.consumers` 就自动解绑旧 consumer；否则上传无 `queue()` handler 的 Worker 会以 11001 拒绝。`0025_remove_score_images.sql` 先用 `INSERT OR IGNORE` 将 `score_image_objects` 的全部注册派生 key 排入 `score_object_deletions`，保留既有删除项身份与时间，再 drop 图片 trigger、objects 和 jobs 表。该迁移发生在 Worker 部署之前，因此必须先停止旧链路写入。随后确认不再产生图片任务，不再访问图片 API，PDF 打开、下载、离线重开、权限与笔记同步通过。校验 `/api/health`、`/build.json` 与目标 SHA；真实 Safari 17.5 验收单列，不提前写成通过。
3. Worker 发布后确认 `same-page-images` 的生产者/消费者均已解绑，复核合并前的排空记录且没有新任务后再退役队列。解绑不会自动删除队列；不要丢弃尚未确认归属的任务。退役脚本仍在 CI 内时保留其所需的 Queue 读写权限；完成退役并移除脚本及 CI 步骤后，再确认 token 无其他 Queue 用途并收回权限。
4. 确认没有旧 Worker 或其他调用者依赖服务，恢复窗口结束后退役 GCP 项目 `same-page-clyapps`、区域 `us-central1` 中的 `same-page-renderer` Cloud Run 服务。仅处理专属服务，不直接删除整个项目。
5. 清理 GitHub Actions 的 `PDF_RENDERER_SECRET`、`GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`，及 Worker 的 `PDF_RENDERER_SECRET`。退役 Secret Manager 的 `same-page-renderer-signing`、专属运行身份 `same-page-renderer`、部署身份 `same-page-deployer` 及其 IAM grants；核实 WIF provider `same-page` 无其他调用方后移除，只有 pool `github-actions` 无其他使用者时才能删除 pool。不要输出密钥值。
6. 确认无需旧镜像恢复后清理同区域 Artifact Registry 仓库 `same-page-renderer` 及镜像，按保留规则处理相关日志。服务停止不代表镜像存储费用停止。
7. 迁移后从 `score_object_deletions` 和存储清理执行结果核验已注册派生对象的删除进度，由现有可重试 R2 清理器执行并复核 PDF 引用。`score_image_objects` / `score_image_jobs` 已被 drop，不再查询它们获取元数据；如需对照清单，应在步骤 1 排空后、迁移前保存。未注册孤立对象须另行只读核实专属 key 与引用，不以整桶或模糊前缀批量删除。保留原 PDF、产品图片、笔记、草稿与恢复规则，不改写历史 D1 migration 或 wrangler 中两条 Durable Object migration。

完成后记录实际操作时间、资源标识与验证结果；旧包回滚需先评估已 drop 表和已执行 R2 删除的不可逆影响，并恢复匹配的数据库恢复点、旧脚本、队列、凭据及服务，不能把仅回滚 Worker 当作完整恢复。

## #269 部署失败恢复

2026-09-10 main `052e972` 的测试和 verify 全部通过，但 Cloudflare 拒绝 Worker version 上传（11001，缺少 Queue handler）。失败前已进入数据库迁移步骤，不能假定生产状态仍等同旧 Worker 的完整 release。恢复发布需使用前述定向解绑，保留恢复点，并在成功发布后验证目标 SHA；不要恢复已删除的图片业务 handler，也不要重写 `0025` 或回滚旧 Worker 来绕过平台检查。

`npm run deploy` 同样在 artifact 验证后执行定向解绑，仍需操作者遵守生产锁、排空、恢复点及迁移前提。此文不代表线上已解绑或已恢复。

参考：[Cloudflare Remove a consumer](https://developers.cloudflare.com/queues/reference/how-queues-works/#remove-a-consumer)。
