# 故障诊断

## 用户与支持人员

1. 在错误发生的同一标签页，通过首页、云盘页或阅读器“更多 → 故障诊断”打开诊断页。不要刷新整个网页；刷新会清空会话诊断。
2. 点击“刷新诊断”，检查文本，再主动复制给支持人员。诊断不会自动上传。绝不索取验证码、邀请码、Cookie、令牌、私人乐谱、批注正文或完整浏览器网络导出。
3. 先按 `operation`（auth/drive/layers/pdf/sync/storage/other）、`stage`、`category` 和版本分组。`id` 是本地事件编号；`requestId` 是服务端请求编号，仅当确实收到该响应时存在。网络失败、PDF.js 内部加载失败可能没有服务端编号。
4. `permission`：检查会话/成员关系/共享层编辑权；`network`：恢复连接后重试；`validation`：修正输入；`conflict`：按阅读器本地冲突流程处理；`rate-limit`：等待后手动重试；`internal`：根据版本与阶段检查代码和部署。`retryable` 仅表示可能恢复，绝不自动重放写请求。
5. PDF 加载失败不等于离线；图层准备失败可再次点铅笔；同步失败保留本机草稿。不要清除站点数据或重装 PWA 作为通用修复。

## 运维日志

在 Cloudflare 的 same-page Worker → Observability Logs 中按 `event=same_page_failure`、`requestId`、`buildId` 过滤。若编号未命中，按时间、操作、阶段、类别查找相邻事件；服务端按每 isolate 的固定操作/阶段/类别每分钟仅输出第一条，后续次数在下一条的 `suppressed` 汇总。不同 isolate 各自限额，不能把日志条数视为全站错误计数，也不保证每个请求都保留日志。

服务端仅输出固定字段，不记录原始异常、堆栈、URL、请求/响应正文、原始邮箱/IP、文件名或任何用户/云盘/乐谱标识。关闭自动 invocation logs 和 traces，Better Auth 原始 logger 保持禁用。平台在其运行设施附加的元数据不等同于应用白名单，本实现不宣称控制 Cloudflare 全部安全/网络日志。

客户端环形记录只在内存中存在：最多 50 条，30 分钟无新发生即过期，同类同阶段 30 秒内合并（计数最高 9999），刷新、关闭标签页或身份切换清空。身份切换前发出的请求即使晚到也不会写入新身份的诊断。诊断失败不改变请求结果，不修改同步协议、重试策略或 outbox。

访问日志只授予必要运维人员，通过现有 Cloudflare 账户权限管理；云盘管理员不因此获得 Cloudflare 权限。诊断复制文本由用户自行决定发送范围。不要将完整支持报告默认发布到公开 Issue。

复用当前 Cloudflare Logs，不开通第三方平台，不升级套餐。依据 [Workers Logs 官方文档](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)（2026-09-04 核对），Free 保留 3 天、Paid 保留 7 天；Paid 超出包含额度可产生费用。部署前后查看实际套餐、日志写入量与授权人员；本仓库配置不设置付费上限或额外导出。超过保留期不能承诺恢复旧日志。需要持久保存/自动客户端遥测时另行讨论隐私、权限、保留与成本。
