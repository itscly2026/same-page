# #269 main CI 失败核实与修复

## 两个独立失败

- main `052e972` / run `34491222099`：checks、visual、integration、verify 成功，deploy 在 Cloudflare 上传 Worker version 时失败，11001 `Queue handler is missing`。PR #259 已移除 queue handler 与 Wrangler 队列配置，但旧云端 consumer 必须显式解绑。PR deploy 被跳过，绿灯不包含生产部署。
- main `82a6892` / run `34488794920`：体验访问隐私用例超过 5000ms（记录 5556ms）；PR #258 中相同代码通过，2318ms。两边 Node 24.20.0、runner 镜像 20260907.300.1 相同。历史日志没有阶段计时，不能据此精确归因当时的运行器负载。

## 测试诊断

Node 24 本地命令：`npm run test:worker:integration -- worker/annotations-flow.test.ts -t 'experience reads'`。

- 原 fixture 单跑通过；在本机并行执行 CI scope 测试期间，重现 `Test timed out in 5000ms`，测试记录 5445ms。没有更改 timeout 或使用 retry。
- 临时在完成断言后注入失败以让 Worker 输出阶段诊断：owner 116ms、首次建谱 1398ms、member 91ms、体验层读取 8ms、体验笔记 15ms，总计 1630ms。
- 仅将公共 annotation fixture 的首次上传改为调用真实 `createScoreVersion`，传入已知有效的一页 PDF 及真实 SHA256：owner 118ms、建谱 23ms、member 84ms、体验层读取 7ms、体验笔记 14ms，总计 247ms。
- 该对照定位出无关 PDF 解析冷启动是此用例主要可移除开销；不能把本机测量当成历史 Ubuntu 失败的精确阶段追踪。

所有临时注入已移除。测试成功时安静，失败或 timeout 时 `worker_experience_stage_timing` 只输出固定阶段名称和毫秒数。沿用 recycle 的 signal 捕获方式，避免测试挂起时遗漏日志。隐私断言、真实认证/成员加入/读取/提交路径及默认 5 秒 deadline 均保留；PDF 上传解析与拒绝坏文件仍由 `scores-flow.test.ts` 覆盖。此改动不替换业务 API 或在生产禁用 PDF 校验。

## 发布修复与边界

通过 `wrangler whoami` 确认身份后只读核查生产队列：`same-page-images` 确有指向 `same-page` 的 Worker consumer。直接读取 consumers API 确认响应身份字段为 `script`，不是文档示例中的请求字段 `script_name`；实现和回归 fixture 使用真实响应形状，不猜测别名，也没有执行生产 DELETE。

`retire-image-consumer.mjs` 按精确队列名和 Worker 名处理旧关联。它枚举分页，验证结果，只删除目标 consumer 后再次读取；不删除消息或队列。权限、网络、异常响应和确认失败均阻止后续步骤。重复执行或列表确认目标不存在时无写入。

CI 在 production lock、admission、artifact 校验、恢复点之后，在 migrations 和 Worker deploy 之前运行。脚本变更显式选择 build/smoke/deploy，避免修复合并后没有部署。`npm run deploy` 同样执行此步骤；退役排空前提见运维文档。

离线 API fixture 回归覆盖遗留关联、重复执行、无关资源、分页、权限/网络失败、畸形结果和删除后仍存在。CI scope 回归先观察到旧规则 `deploy=false` 的失败，再验证修正。

本地与 PR CI 不证明生产已解绑或恢复，合并后仍需 deploy 和线上目标 SHA 验证。

## 本地验证记录

- Node 24：typecheck、lint、Node/Vitest 单元 105 项通过。
- Worker 单元 6 项通过；默认并发集成运行中目标用例通过，但另一个首次上传用例在本机负载下超时（5303ms）。以 `--maxWorkers=2` 运行完整集成 110 项通过；这是本机验证的资源约束，未更改 CI 并发或 timeout。
- PR CI 需使用 Ubuntu 原配置复核，不能将上述本机绿灯当作 CI 结果。
