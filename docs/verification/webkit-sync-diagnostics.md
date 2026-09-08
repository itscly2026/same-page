# WebKit 同步扫描与本机副本诊断

## 本次需求与审查基线

用户授权：修复已复现的 WebKit 待同步扫描问题，同时补齐阅读器同步和离线副本检查的安全诊断；实现后先 review。审查基线为 `2c5ece3`，不包含其它工作区的导航改动。不在本次工作中部署或清理用户数据。

- 替换 `uniqueKeys()`，保留按本机身份隔离、800 个待发现谱子上限、每轮最多 8 个谱子、每谱最多 100 项操作，以及轮转和退避。
- 用真实 Chromium/WebKit 覆盖空队列、重复操作、跨谱轮转和用户隔离。模拟 IndexedDB 测试不足以保护该故障。
- 诊断只增加白名单步骤与错误类型，不保存原始异常、堆栈、文件名、身份标识或笔记正文；不同步骤/错误类型不能被合并。取消、身份切换及旧会话迟到结果不能污染新诊断。
- 区分副本校验失败与本机读取异常；读取异常提供重新校验，不直接要求重新下载。
- 不改同步协议、业务重试/退避、OCC、本机草稿、已激活副本的原子写入规则。

## 实现

待同步扫描使用普通索引 `firstKey()`，每次把完整复合键作为下一次排他下界；直接跨过同谱重复操作，不先截断操作列表再去重。两段扫描在一个只读事务中完成，先扫描轮转游标之后，再回到开头，合计最多发现 800 个谱子。

诊断报告增加可选 `step` 和 `errorType` 固定枚举，服务端严格验证；保留原有报告格式、匿名提交和 30 天期限。阅读器同步记录图层准备、推送、拉取检查点/请求、应用云端结果、本机草稿与冲突操作的失败。本机副本检查区分文件、图片清单、笔记快照验证以及本机读取异常；异常保持原样交还业务流程，白名单之外的名称降为 OtherError。

## 证据与边界

`node --test browser-tests/outbox-browser.test.mjs` 使用真实模块和持久化浏览器 IndexedDB。修复后 Chromium/WebKit 均通过。临时换回原 `uniqueKeys()` 后，同一 WebKit 测试在空队列扫描断言处失败（实际 failed，期望 completed），随后恢复修复代码。负对照改动不进入提交。

线上原始报告只有 sync/internal/prepare，未保存底层异常；本地复现支持这一修复，但不能证明用户 iOS PWA 的全部现象都由它引起。桌面 WebKit 不替代 iOS 真机验收。阅读器的同步失败状态和本地副本不可用仍需部署后用新诊断核对。

## Review 修正

首轮 Standards 发现 1 项会话隔离问题；Spec 发现 3 项，其中该会话问题重复。已按三个独立问题修正：整个离线检查沿用入口捕获的诊断 scope；阅读器操作传入原始取消信号并在记录前检查；已读到的损坏笔记快照先做结构校验，按无效副本处理。新增延迟读取跨身份重置、取消后的迟到数据库错误、缺失/空值快照数组回归。临时恢复首轮代码后这些回归失败，修正后通过。

## 最终验证

代码提交 `79001cb` 经 Standards/Spec 两个独立 reviewer 复审，剩余问题均为 0。

使用 worktree 独立 `npm ci --ignore-scripts` 依赖与 CI 同系列 Node 24（本地 v24.20.0）：

- `npm run test:client -- --maxWorkers=2`：55 文件、468 项通过。
- `npm run test:unit -- --maxWorkers=2`：21 文件、79 项通过。
- `npm run test:worker:integration -- worker/diagnostic-reports.test.ts`：11 项通过。
- `node --test browser-tests/outbox-browser.test.mjs`：Chromium/WebKit 2 项通过。
- `npm run lint`、`npm run build`（含 TypeScript 与 precache 校验）：通过。

此前 Node 25 的实验性 localStorage、共享依赖软链的 Vite 文件访问限制以及高并发时本机资源争用影响了全量验证；改用上述独立依赖、Node 24 和两 worker 后全量通过。没有为这些环境失败修改产品行为或放宽断言。

以上为本地证据；未执行远程 CI、部署或用户 iOS PWA 验收。
