# 本地开发初始化

## 环境与认证

先在仓库根目录执行 `npm ci`，再将 `.dev.vars.example` 复制为忽略提交的 `.dev.vars`。
为 `BETTER_AUTH_SECRET` 与 `INVITE_SECRET` 分别设置至少 32 个字符的独立随机值。
注册和密码重置需要 Same Page 专属 Resend key；不得复用 Webmail 的凭据。
不在日志或提交内容中记录 OTP、收件人、邮件正文、邀请码或 Secret。

Google 与微信是可选配置：分别成对设置 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
和 `WECHAT_CLIENT_ID` / `WECHAT_CLIENT_SECRET` 才启用入口。平台配置及真实授权检查见
[发布 runbook](../operations/production-release.md#第三方登录配置)。

```bash
npm run db:migrate:local
npm run dev
```

Wrangler 为本地 D1 和 `SCORES_BUCKET` 使用本地存储，不需要访问生产 D1/R2。

## 创建首个云盘

首位管理员先在页面设置密码并完成邮箱 OTP 注册。随后通过受控进程环境向 CLI 提供
与 `.dev.vars` 相同的 `INVITE_SECRET`，执行：

```bash
npm run provision:choir -- \
  --admin-email admin@example.com \
  --admin-display-name 管理员 \
  --local
```

默认创建“小红花云盘”。命令默认操作本地数据库；生产必须显式使用 `--remote`，并遵循
[首次发布步骤](../operations/production-release.md#首次发布)。

邀请码默认不输出，管理员可在产品的「管理 → 邀请码」查看和分享。仅人工确实需要即时
交付时使用 `--show-join-code`；原码不得进入 Issue、PR、日志或长期存档。

如需本地公开体验入口，在同一命令中增加：

```text
--choir-name 公开体验云盘 --guest-admission open --preview-entry
```

`--preview-entry` 只能与开放准入一起使用，数据库最多允许一个该入口。已有开放准入
云盘须通过受控 SQL 明确设置 `is_preview_entry = 1`，不会按名称自动识别。
产品入口及访问规则见 [CONTEXT](../../CONTEXT.md)。

`0011_retrievable_join_codes.sql` 不改变旧邀请码。旧码如果只有校验值，无法还原；
管理员可在界面补录当前原码，校验一致后保存密文，或主动轮换。正常查看和轮换不需要
再次执行初始化命令。

## 认证 schema

Better Auth 定义由官方 CLI 生成。认证模型变化时运行 `npm run auth:schema` 并审查
`worker/db/auth-schema.generated.ts`；实际 D1 变更仍通过 `migrations/` 执行。

验证命令及浏览器/Python 依赖见 [CI 检查与开发反馈](../operations/ci.md)。
