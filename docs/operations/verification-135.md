# #135 批注编辑与同步

## 命令边界与事务不变量

`src/client/annotations/annotation-state.ts` 是批注内容、历史意图、outbox、冲突、确认、pull 的持久化写入边界。传输模块只负责请求和 scope 锁；跨谱恢复仍由应用层驱动。

- `saveAnnotationDraft/saveDraftWithHistory/undoAnnotationEdit/redoAnnotationEdit` 产生内容意图。历史不保存 version、pending、opId 等同步元数据。草稿入队由 `queueScoreDrafts` 明确发布。
- 每对象最多一个已尝试操作和一个未尝试后继；发送时先处理已尝试操作，后继只能在确认前驱后发送。已尝试操作保持原 opId 与请求内容。
- 确认事务只消费仍在 outbox 的操作；重复响应无效。确认 A 时，未提交 B 保持草稿；已入队 B 更新 baseVersion。删除未创建对象不产生 version-zero delete；结果不确定的新建先以原 opId 重试。
- 冲突以当前本机内容为准，后续编辑更新冲突内容。重新应用基于云端版本，保留两份使用新对象身份；所有读取与写入在同一 owner/scope 事务中完成。
- 单层失权保留原 outbox 身份和本机内容，以 `sync-error/permission_denied` 表达。合法对象照常提交，手动重试解除阻塞。push 失败不阻止允许读取的 pull。
- 恢复按不同 scope 发现，持久化轮转位置与指数退避；每轮最多 8 谱、每谱 100 操作。Dexie v8 只增加发现索引，不删除草稿。
- D1 批次按独立对象分组；每组 5 条集合 SQL 在一次 batch 事务中执行权限、幂等身份、OCC、对象写入与结果读取。同对象按请求顺序分组。事务内 processing/resulting_version 是临时应用标记，提交时不存在 processing 行。
- 成员关系 现有 lifecycle_revision 在移除、恢复或角色变化时原子递增；授权写入同时比较操作者及目标成员状态和 revision，迟到请求不能跨越恢复边界。

## 回归证据

修改前：未入队 B 被 A 的冲突覆盖（重新应用与保留两份各失败一次）；服务器确认后撤销恢复 version=0/pending；805 条单谱操作挡住第九谱；push 403 阻断 pull。上述回归先失败再修正。

## 真实本地 Worker/D1 基准

使用 `worker/annotations-flow.test.ts` 的实数据库批次场景；D1 绑定仅计数，所有 SQL 都交给实际迁移后的本地 D1 执行。统计包含认证、准入与同步请求，耗时为本地请求耗时，不代表生产边缘网络延迟。

| 操作数 | 之前 SQL / 绑定往返 / ms | 之后 SQL / 绑定往返 / ms |
| --- | --- | --- |
| 1 | 14 / 11 / 6 | 11 / 6 / 6 |
| 100，共享与个人混合 | 905 / 605 / 169 | 11 / 6 / 40 |

平台依据：[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)：每调用 SQL 上限 Free 50 / Paid 1000，单语句绑定参数 100、SQL 长度 100 KB。集合输入使用 JSON 绑定，避免按 100 对象展开参数。正常独立批次固定 11 条 SQL；极端同对象 100 项串行批次最多 506 条，需 Paid 配额。产品客户端每批每对象只提交一项。

复跑：`npx vitest run --config vitest.worker.config.ts worker/annotations-flow.test.ts -t 'measures real local' --reporter=verbose --disableConsoleIntercept`。


## 最终验证与审查

- `npm run check:full` 通过：PWA 更新、14 CI 测试、36 shared/node 测试、267 client 测试、7 Worker 单元与 58 Worker/D1 集成测试、31 视觉回归、迁移、构建、2 项真实浏览器存储冒烟，以及加载性能门禁。
- 审查追加的删除冲突、后台 busy 轮转与 Web Locks 非阻塞回归分别通过对应单文件测试；真实 Chromium + IndexedDB + Worker/D1 再次验证上传中编辑/撤销/重做、关库重开、A→B→A 迟到响应、混合层权限、恢复权限后重试与双标签持锁。
- [浏览器测试](../../browser-tests/annotations-smoke.test.mjs) 使用真实密码登录和产品命令，不预置批注数据，不伪造 API 响应；只延迟真实响应以确定性触发竞态。另一独立浏览器上下文通过真实 pull 验证云端结果。截图输出 `artifacts/verification/annotations-135.png`。
- Standards 审查发现快照/退出清理绕过状态边界，已迁入命令；Spec 审查发现状态探测及后台 Web Lock 可无限等待，已加入请求超时与非阻塞取锁，busy 后继续轮转。
- 本次仅完成本地实现、提交和验证；没有生产部署或真实移动设备验收。

后续 #165 将编辑会话与历史操作迁移至 `AnnotationEditor`，取代上文历史记录中的 `saveDraftWithHistory`、`undoAnnotationEdit` 和 `redoAnnotationEdit`。本地草稿事务与同步元数据规则保持不变，真实 Worker/D1 smoke 已迁移到新编辑 module 的 interface。
