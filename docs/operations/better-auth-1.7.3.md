# Better Auth 1.7.3 发布与回滚

关联：#310、#264。密码长度不属于本次升级。

## 阶段 A：旧应用兼容迁移

先发布 migration 0026，应用仍使用 1.7.2。上线管道先以聚合查询检查 `(provider_id, account_id)` 重复，再由 D1 migration 原子地重建 account；复制所有字段，保留 nullable issuer，移除旧唯一索引并建立 provider 唯一索引。失败时阻止 Worker 发布，不自动修复身份冲突。不得修改 migration 0001。

旧应用仍写入 issuer，因此迁移后仍可运行。检查脚本不记录用户身份、密码哈希或令牌。迁移本地 D1 验收比较所有认证字段、用户和会话；外键级联与重复键拒绝也受测。

## 阶段 B：切换认证依赖

阶段 A 部署验证成功后，才发布统一版本的 better-auth、drizzle-adapter 和 auth CLI。保留数据库兼容列，但新应用不再将 issuer 作为认证身份键。发布前必须通过旧账户登录、Google 身份、新注册、首次设置密码、重置密码及回滚演练。

旧版页面/API 客户端没有变化，不要求用户改密码或重新注册。不要删除 user、membership、annotation 数据，不自动合并重复身份。

## 回滚边界

阶段 A 可以回退应用而保留 migration 0026。阶段 B 一旦写入 NULL issuer，不能直接回退原版 1.7.2：旧库可能无法查找这些身份。

阶段 B 发布须带有受测回滚流程：暂时停止认证写入（包括 Google 回调、注册、设密、重置和在途请求），按当前仅支持的 credential/Google provider 回填缺失 issuer，校验旧身份唯一性，再部署阶段 A 的应用，确认密码与 Google 登录成功才恢复认证入口。不得在新 Worker 仍可能创建身份时执行回填后直接切换。

回填命令为 `node scripts/prepare-auth-rollback.mjs --remote --auth-writes-paused`。该参数是操作人员对已停写并排空请求的声明，工具本身不创建维护窗口。先通过维护 Worker 暂停整个 `/api/auth/*` 路径、等待在途请求结束并确认流量停止，保留其他业务服务；回填后部署阶段 A 版本再恢复入口。在入口恢复前以受控请求验证密码与 Google 登录。没有可验证的停写窗口时不得执行此回滚，维持新版应用并向前修复。

SQL 仅支持 credential/Google，拒绝未知 provider 或不匹配的既有 issuer。它只更新 NULL issuer，保留所有升级后写入，不逆转 migration 0026。本地 D1 测试覆盖拒绝时原子回滚、字段保留与幂等；同一认证测试在 1.7.2/新版本分别验证回填后密码与 Google 登录、原 user ID 和会话。不要自动还原上线前数据库备份，它会丢弃上线后的合法写入；Time Travel 只是灾难恢复手段。

## 本次验证记录

Node 24.21.0：阶段 A 的 21 项认证测试通过。回滚认证用例在阶段 A（1.7.2，NULL issuer 模拟新版记录）以及阶段 B（1.7.3 实际创建记录）分别执行通过。阶段 B 完整 Worker 测试 125 项通过，local D1 执行真实 migration/rollback SQL 并验证拒绝未知 provider 时不发生部分更新。生产停写、真实 Google OAuth 和真实发布回滚尚未执行。

依赖固定在 1.7.3，`@better-auth/core` override 跟随 `$better-auth`，避免 adapter 的 peer range 自动引入另一个 core 版本。Dependabot 将认证包和 CLI 分组更新。`auth:schema` 重新生成后须保留本项目额外的 nullable issuer 过渡列与 provider 联合唯一索引定义，不可将 CLI 输出直接作为生产迁移。
