# Same Page PDF 图片渲染：Cloud Run 评估

> 历史记录：本文描述当时的实现与验证。#156 已移除图片显示、专属 renderer 及其部署/测试入口；相关旧命令和路径不再适用。当前决定见 [ADR0013](../adr/0013-provide-independent-image-score-display.md)，资源处置见 [退役步骤](../operations/image-renderer-retirement.md)。原测量不代表当前性能或 Safari 17.5 真机验收。

核查时间：2026-09-06 10:48 CST。范围为账号、已部署资源、Monitoring 用量、官方价格及本地渲染实验；没有启用 API、修改 IAM、开通套餐或部署服务。

## 结论

建议把独立 PDF → PNG 渲染器部署成 Cloud Run 按请求计费的 Service，使用现有 Same Page GCP 项目，初始配置 `us-central1 / 1 vCPU / 1 GiB / min instances 0 / max instances 1 / concurrency 1`。OMR 的账号和 GitHub 部署模式可以参考；不应把轻量渲染塞进现有 Audiveris Job。

计算免费额度充裕。按每份乐谱计费 30 秒预算，完整计算额度理论支持约 6,000 份/月；这不是端到端免费容量。两份真实乐谱生成的双档 PNG 分别为 10.35、28.88 MiB，完整 1 GiB 出网额度仅支持约 98、35 份。该出网免费额度还有北美地域条件，Cloud Run 到当前 R2 路由尚未验证，不能承诺 35–98 份绝对零费用。

因此这是“没有计算月租、低用量接近免费”的选择。账户已有镜像存储超过免费档，不能宣称整个 Google Cloud 账单为零。

## 现有账号与资源：实时核查

本地 `gcloud auth list` 确认登录账号为 `itscly2026@gmail.com`。结算账号已开启，两项目均已启用结算，且属于同一个结算账号。报告不记录凭据、token 或结算账户标识。

| 项目 | 已核查状态 |
| --- | --- |
| `skilful-earth-490004-u3` | OMR 生产项目，区域 us-central1 |
| `same-page-clyapps` | 已存在并关联结算；Cloud Run、Artifact Registry API 尚未开启 |

OMR 当前资源：

- `optical-music-recognition-api`：第二代 Cloud Function 对应的 Cloud Run Service，0.3333 vCPU、512 MiB、并发 1、最多 1 实例、请求超时 120 秒。
- `optical-music-recognition-runner`：Cloud Run Job，2 vCPU、4 GiB、单任务、并行度 1、任务超时 1,800 秒、重试 0。
- Artifact Registry 两仓库合计 2,070,144,347 bytes，即约 1.928 GiB。

`music-ocr` 当前主要承载 Chorus 前端；OMR 服务与部署脚本在相邻 `optical-music-recognition` 仓库。其 GitHub Actions 使用 Workload Identity Federation。参考的是配置模式，不复用 OMR 的运行凭据或扩大其权限。

核查命令包括 `gcloud billing projects describe/list`、`gcloud run services/jobs describe/list`、`gcloud run jobs executions list`、`gcloud artifacts repositories list`、`gcloud services list --enabled`。输出仅选取资源与计量字段，没有读取或输出 Secret 值。

## 当前用量

通过 Cloud Monitoring v3 `projects.timeSeries.list` 累加 DELTA 数据，查询 OMR 项目所有可见 Cloud Run 资源，包括历史名称。9 月截至 2026-09-06T02:47:53Z；月份按 UTC 区间查询。

| 指标 | 2026 年 8 月 | 2026 年 9 月截至核查 |
| --- | ---: | ---: |
| CPU allocation time，vCPU·秒 | 7,674.533 | 123.130 |
| Memory allocation time，GiB·秒 | 13,794.704 | 245.150 |
| 到达容器的 HTTP 请求 | 548 | 37 |
| sent bytes，所有网络分类合计 | 47,076,831 | 275,185 |

这些监控值说明现有负载很低；它们不是 Cloud Billing 已结算用量或余额。网络分类包含 google/private/internet，不能把总数直接等同付费互联网出网；历史配置、计费模式、启动 CPU boost 以及账单 SKU 也会影响折算。

另查当前 Job 保留的执行记录：8 月 20 次、9 月 1 次。执行 start 到 completion 的累计墙钟时间分别约 6,230、217 秒，与容器计量不同，不能直接拿执行墙钟时间替代账单。

本次没有读取账单导出或结算后 SKU 明细，所以不声称“本月精确剩余 99.x%”。Same Page 项目尚未开启 Run API；现有已核查负载远未接近上述完整计算额度。

## 免费额度与成本模型

按 us-central1、美元按量价格估算。免费额度按结算账号汇总、每月重置；项目隔离不增加额度。混合 Job/Service 的精确抵扣以账单为准，不把两类免费档简单相加。[Cloud Run 定价](https://cloud.google.com/run/pricing)

| 计费模式 | 月 CPU 免费档 | 月内存免费档 | 请求 |
| --- | ---: | ---: | ---: |
| Service 按请求计费 | 180,000 vCPU·秒 | 360,000 GiB·秒 | 200 万 |
| Job / Service 按实例计费 | 240,000 vCPU·秒 | 450,000 GiB·秒 | Job 无 HTTP 请求计费项 |

按请求计费适合零散转换；请求处理、启动和关闭会计费，网络等待也包含在请求持续时间内。配置 min instances 0。Job 每次每实例至少计费一分钟，因此对几秒至几十秒的转换，优先 Service。[计费模式](https://docs.cloud.google.com/run/docs/configuring/billing-settings)、[Job 最低计费](https://cloud.google.com/run/pricing)

1 vCPU、1 GiB 的完整计算额度折算如下，尚未扣共享账号其他服务、启动开销、失败和重试：

| 每份总计费时间假设 | 计算容量上限/月 |
| --- | ---: |
| 10 秒 | 18,000 份 |
| 30 秒 | 6,000 份 |
| 60 秒 | 3,000 份 |

一份代表一个尚未生成图片的不可变 PDF 版本；转换后所有读者复用 R2 结果。打开次数、团员人数不直接增加 Cloud Run 渲染次数。

## 本地实测与出网限制

在 macOS 使用现有 `renderer/render.py`，临时 uv 环境安装仓库指定的 pypdfium2 5.13.0、Pillow 12.3.0；逐页生成 2048、3072 两档 PNG，包含 Python 子进程启动和一次 inspect。没有上传样本或修改源 PDF。

| 样本 | 页数 | PDF bytes | 两档 PNG 合计 | 本地总耗时 | 1 GiB / 输出量向下取整 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 仓库合成测试谱 | 3 | 132,994 | 1.118 MiB | 6.487 秒 | 916 份 |
| 舟中晓望 | 11 | 18,234,815 | 28.883 MiB | 7.616 秒 | 35 份 |
| 道别是一件难事 | 8 | 1,200,912 | 10.352 MiB | 3.038 秒 | 98 份 |

真实 PDF 位于相邻 OMR 仓库 `output/manual-transcription`。这是两个具体样本，不代表所有扫描谱；第一轮包含环境首次启动开销，不能比较三者的稳态性能。macOS 时间不等于 Cloud Run 1 vCPU 时间，也不包含云端冷启动、请求和 R2 写入等待。因此容量采用 10/30/60 秒情景，不把本地速度当云端吞吐承诺。

Cloud Run 只有每月 1 GiB 北美范围免费互联网出网。R2 免费出网并不免除 Google 侧发送 PNG 的费用；跨云目标地域、路由和最终账单需部署后小样本验证。这里没有假定 Cloudflare 互联优惠。[Cloud Run 出网规则](https://cloud.google.com/run/pricing)

按北美出网超出部分 $0.12/GiB 的标准情景计算：100 份、每份 10–30 MiB，PNG 约 0.98–2.93 GiB，对应出网约 $0–$0.23；1,000 份约 9.77–29.30 GiB，对应约 $1.05–$3.40。若 1 GiB 免费档不可用，分别增加约 $0.12；其他目的地域单价可能不同。这些仅为出网项，未含重试、其他项目占用、镜像及存储费用。[网络定价](https://cloud.google.com/vpc/network-pricing)

## 容易遗漏的费用

- Artifact Registry 免费 0.5 GiB/月，超过约 $0.10/GiB·月。现有 1.928 GiB 若保持整月，超过免费档部分约 $0.14/月；这是存储快照推算，不是已发生账单。新增渲染镜像另计，建议保留有限版本并设置清理策略。[镜像定价](https://cloud.google.com/artifact-registry/pricing)
- Cloud Build 默认池 e2-standard-2 每结算账号每月 2,500 免费构建分钟；不是所有机器类型免费。也可沿用 GitHub Actions 构建，但其配额另算。[构建定价](https://cloud.google.com/build/pricing)
- R2 存储和操作、Cloudflare Queue/Worker、日志及可选镜像漏洞扫描是独立计量。本次没有计算整个应用的剩余额度，不能据此保证全部基础设施零账单。

## 迁移适配范围

当前需求是独立服务端 PDF 栅格化，保留 PDF.js 默认路径、双档 PNG、不可变 PDF 版本、R2 权限、D1 generation job、幂等重试和完整 manifest 发布。参见 [ADR 0013](../adr/0013-provide-independent-image-score-display.md)。

1. 为 Same Page 部署独立轻量服务，不加载 OMR 的 Java/Audiveris 镜像。
2. 修改 Worker 的 renderer transport 和发布流水线，移除 Cloudflare Container 绑定，保留现有 Queue、D1、R2 业务边界。
3. 重设计跨云传输。当前 `/inspect` 加每页每档 `/render` 都重传整份 PDF：11 页需要 23 次整 PDF 传输，约 400 MiB 输入。建议一份文档一次任务，使用短期、限定对象的读取/写入授权；逐页上传输出，最后再发布 manifest，避免全部 PNG 同时驻内存。
4. 处理 Cloud Run HTTP/1 请求和非流式响应 32 MiB 限制。当前上传 20 MiB 可容纳，但渲染器允许 50 MiB；不能直接把总输出打包成一个巨大普通响应。[Cloud Run 限制](https://docs.cloud.google.com/run/quotas)
5. 单独设计 Worker 到 Run 的身份验证。GitHub Actions 的 WIF 只解决部署身份，不自动解决 Worker 运行时身份。IAM 私有调用需要可信身份提供者和 ID token；若选择应用层签名鉴权，也必须明确公网入口及拒绝请求的计费影响。[外部服务身份验证](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
6. 验证完整 PDF 渲染、内存峰值、失败重试、私有 PDF 访问边界、冷启动、实际 Cloud Run 计量和 Google→R2 出网归类，再调整预算。max instances 1 和任务数/字节数限额用于控制规模，不能单独保证零收费。

本次结论支持选择 Cloud Run，但尚未实施迁移；原 CI 的 Cloudflare Containers 套餐与权限问题不会因这份评估自行消失。
