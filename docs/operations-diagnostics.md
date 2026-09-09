# 故障诊断

## 用户反馈

在问题发生的同一标签页，通过页脚「故障诊断」或阅读器「更多 → 故障诊断」打开。阅读器错误/加载页面也有入口，面板不离开阅读器。不要刷新整个网页；刷新会清空会话记录和待发送内容。

可选填「刚才遇到了什么问题」，查看折叠的诊断内容后点击「发送诊断」。无需登录，即使没有错误记录也可反馈。发送仅由用户点击触发，报告包含明确列出的环境状态和错误，不截图、不读取 PDF、批注正文、文件名或完整网址。用户输入的文字是主动提交内容，不能承诺自动识别其中的敏感信息；提示用户不要输入凭据或私人内容。

成功回执给出反馈编号，表示 D1 已保存，不表示故障已修复或维护人员已经阅读。超时/断网表示尚未确认收到，当前会话内保留原快照并支持手动重试、复制。重试同一编号和内容不会新增记录，不自动补发。可「填写另一份反馈」提交新的现场；旧反馈可能已收到。本地清空不会撤回服务端报告。刷新、关闭标签页、切换身份都会清空当前会话，迟到响应不能覆盖新身份。

诊断发送使用独立请求，不修改同步协议、业务重试策略或 outbox。不把 PDF 加载失败等同于离线；网络提示仅来自浏览器。图层准备失败可再次点铅笔，同步失败保留本机草稿，不要清除站点数据或重装 PWA 作为通用修复。

## 私有收件箱

第一版是运维 CLI，使用当前 Cloudflare D1 账户权限，**不新增产品管理员角色、公开报告查询 API 或邮件通知**。只授权必要维护人员访问 Cloudflare；云盘管理员没有收件箱权限。请把报告内容当作不可信用户数据，不执行其中的命令或链接，不把完整报告默认附到公开 Issue。

部署先应用 `0016_diagnostic_reports.sql`。本地可用 `npm run db:migrate:local`。生产沿用 CI 的迁移/发布流程。命令必须显式选择 `--local` 或 `--remote`；remote 使用已有 Wrangler 授权，凭据只通过子进程环境注入，不写入命令、日志或文件。

```sh
npm run diagnostics:inbox -- list --remote --status new
npm run diagnostics:inbox -- list --remote --build abcdef1 --category network
npm run diagnostics:inbox -- show --remote --id REPORT_UUID
npm run diagnostics:inbox -- mark --remote --id REPORT_UUID --status investigating
npm run diagnostics:inbox -- mark --remote --id REPORT_UUID --status resolved
```

`REPORT_UUID` 替换为完整反馈编号。列表最多最近 100 份，不输出问题描述；按编号查看才返回完整报告。状态为 `new` / `investigating` / `resolved`，改变状态不延长保留期限。报告创建起保留 30 天，查询排除到期报告，每小时清理全部过期记录，清理失败由现有 Worker 异常监控发现；各清理任务独立执行。

没有自动通知，值班维护人员应在支持排查时或日常巡检中查看 `new` 报告。用户可以携反馈编号联系维护人员；不承诺自动回复，不从登录邮箱推断联系方式。形成产品修复 ticket 时只提取必要、脱敏的复现信息。

## 排查与关联

先按客户端版本、环境、`operation`（auth/drive/layers/pdf/sync/storage/other）、`stage`、`category` 分组。报告 `id` 是反馈编号；每条记录的 `id` 是本地事件编号，`requestId` 是收到服务端响应时得到的请求编号。网络失败、PDF.js 内部失败可能没有服务端编号。

- `permission`：检查会话/成员关系/共享层编辑权。
- `network`：恢复连接后重试。
- `validation`：修正输入。
- `conflict`：按阅读器本地冲突流程处理。
- `rate-limit`：等待后手动重试。
- `internal`：根据版本与阶段检查代码和部署。

`retryable` 仅表示可能恢复，绝不自动重放写请求。仅凭错误类别不能定位到具体代码行；复现异常、部署版本、环境和服务端记录共同支持判断。报告保留 30 天不等于关联的运行日志也保留 30 天。

在 Cloudflare same-page Worker → Observability Logs 中按 `event=same_page_failure`、`requestId`、`buildId` 过滤。服务端每 isolate 的固定操作/阶段/类别每分钟只输出第一条，后续次数在下一条 `suppressed` 汇总，因此不能保证每个请求编号都命中，也不能把条数当作全站错误计数。未命中时按时间、操作、阶段、类别排查。

## 数据边界与运维限制

客户端错误环形记录只在内存中存在：最多 50 条，每条最后发生起 30 分钟过期，同类同阶段 30 秒内合并（计数最高 9999）。发送时冻结一份白名单快照，待发快照在当前会话中保留到清空/身份切换/网页关闭；不持久写入浏览器存储。

服务端按严格嵌套 schema 验证，正文最多 64 KiB，描述最多 1000 字符；只接受本站 Origin 的 JSON 请求。来源检查不能代替防滥用：每个散列地址 15 分钟最多 20 次尝试，新报告全站每日窗口最多 2000 次，响应 429 时带 Retry-After。散列地址只进短期限流表，不进入报告，复用现有限流清理。无有效客户端地址时共用 unknown 限流桶，不信任用户提供的转发地址。需要调整限额时核对共享网络用户与真实收件量。

服务端存储完整报告但运行日志只输出固定分类，不记录描述、原始异常/堆栈、URL、请求/响应正文、原始邮箱/IP、文件名或用户/云盘/乐谱标识。自动 invocation logs、traces 和 Better Auth 原始 logger 保持禁用。平台附加的元数据、备份和安全日志受其自身策略约束。

复用当前 Cloudflare Worker、D1 和 Logs，不开通第三方平台或升级套餐。依据 [Workers Logs 官方文档](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)（2026-09-06 核对），Free 保留 3 天、Paid 保留 7 天。D1 报告的存储/读写受现有套餐额度约束，本实现不设置套餐付费上限。上线后核对收件量、限流、清理结果及账户授权。

## 本机失败的细分字段

`step` 和 `errorType` 为可选白名单字段。先用 step 区分 outbox-scan、sync-lock/layers/push/pull/apply、draft-save/sync-retry/conflict-resolve、offline-read/file/manifest/snapshot；再结合固定错误类型判断数据库/Blob 读取异常、配额不足或验证失败。ValidationError 代表校验拒绝，OtherError 代表不在白名单内的异常类型，不保留原始名称、message 或 stack。同阶段但步骤或错误类型不同的事件分别保存。

“暂时无法读取本机副本，请重试校验”表示尚未确认副本有效性；点击“重试校验”重新读取和验证，不删除、替换或重新下载副本。与已读到内容但校验未通过的“本地副本不可用，请重新下载”分开。相关实现和真实浏览器负对照见 `docs/verification/webkit-sync-diagnostics.md`。

### 离线副本与打开故障（#221）

`sync-layers` 现在细分为 `sync-layers-request`、`sync-layers-response`、`sync-layers-identity`、`sync-layers-cache`、`sync-layers-snapshot`，分别定位请求、响应解析、身份/层完整性、缓存事务与离线快照更新。`errorCode` 只接受固定枚举；`errorType` 可区分 `BulkError` / `ModifyError`，`causeType` 只保留有界嵌套异常中的白名单类型（如 `NotFoundError`）。不记录异常原文、任意字段、文件名、笔记或凭据。

打开超时以 `reader-source`、`reader-document`、`reader-presentation` 区分尚未选定源、文档未就绪及首屏未呈现。PDF 文档就绪不等于首屏已显示。诊断证明某个失败步骤，不自动证明 Safari 底层文件异常的触发原因；真实 iPad PWA 验证需先核对设备 buildId，再分别执行打开、下载、清理后重试、断网重开、联网同步。
