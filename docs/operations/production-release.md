# Production release runbook

本页把“代码通过”“已发布”“域名可达”“邮件可投递”和“实机验收”分开记录。任一项
通过都不能替代其余项目。

## 固定生产边界

- URL：`https://samepage.clyapps.com`
- Worker：`same-page`，关闭 `workers.dev` 与 preview URL
- D1：`same-page-production`（APAC）
- R2：`same-page-production-scores`（APAC、Standard）
- 邮件发件人：`Same Page <login@clyapps.com>`
- Resend key：Same Page 独立、Sending access、只允许 `clyapps.com`
- CI Cloudflare token：Same Page 独立，只包含 Workers Scripts Write、D1 Write、
  Workers R2 Storage Write、Account Settings Read，以及 `clyapps.com` 的 Workers
  Routes Write

生产 Secret 只存在于 Resend、Cloudflare Worker 和 GitHub Actions 的 secret store。
不得写入仓库、Issue、PR、日志、终端历史或发布记录。

## 首次发布

首次发布由运维人员完成以下步骤：

1. 创建生产 D1 与 R2，并核对区域、名称和绑定。
2. 对生产 D1 执行全部 `migrations/`。
3. 在 Worker Secret 中设置彼此独立的 `BETTER_AUTH_SECRET`、`INVITE_SECRET` 与
   `RESEND_API_KEY`。
4. 部署 Worker 与静态资源；Wrangler 的 custom domain 配置负责创建 DNS 记录和证书。
5. 在 GitHub `production` environment 中设置 `CLOUDFLARE_API_TOKEN` 与
   `CLOUDFLARE_ACCOUNT_ID`。
6. 运行 `npm run verify:deployment -- https://samepage.clyapps.com`。
7. 首位管理员完成 OTP 注册后，通过受控命令创建“小红花云盘”。自动化命令不显示
   初始邀请码；管理员首次登录后在云盘页面轮换，并立即通过私密渠道交付新码。
8. 如需启用“公开体验”，使用 `--guest-admission open --preview-entry` 创建唯一的公开体验云盘；已有开放准入云盘必须通过受控 SQL 明确设置 `is_preview_entry = 1`，不得按名称自动匹配。

后续 `main` 发布必须先通过 CI 的 lint、typecheck、客户端测试、Worker 测试和生产构建。
deploy job 随后执行 D1 migrations、Wrangler deploy 与线上机器验证；迁移或验证失败时
workflow 失败，不能记为发布成功。

## 每次发布记录

在对应 Issue 或 PR 中分别记录：

| 门槛 | 可接受证据 |
| --- | --- |
| 代码 | commit、PR、完整 `npm run check` 结果 |
| CI | verify 与 deploy job 的 workflow URL 和结论 |
| Cloudflare | Worker deployment ID、D1 migration 状态、R2 绑定 |
| 生产 URL | HTTPS、应用壳、manifest、Service Worker、`/api/health`、未登录 401 |
| DNS | `samepage.clyapps.com` 的解析与证书；不得改动根域邮件记录 |
| 邮件 | QQ、163、Gmail、Outlook 各一次真实 OTP 到达与延迟；不记录 OTP |
| 人工验收 | iPad Safari、Android 平板、大陆真实网络的设备、浏览器版本与结论 |

## 人工验收脚本

每台目标设备至少完成一次：

1. 以未安装网页打开，登录并进入乐谱；再安装 PWA 重复核心路径。
2. 切换翻页与连续滚动，验证触摸/手写笔在阅读模式不产生批注。
3. 进入编辑后确认默认文本工具；验证文本、画笔、橡皮和完成编辑。
4. 下载离线副本，断网并重启；确认 PDF、共享层和个人层可用。
5. 离线编辑后恢复网络，手动同步并确认待上传数归零。
6. 制造同一对象冲突；确认冲突只在提交设备本地出现，云端仍只有规范版本。
7. 在存在待上传或冲突时退出；确认必须明确取消或丢弃。
8. 用户 A 的会话自然过期后继续离线编辑；以 A 重新登录，确认原草稿可同步且待上传数归零。
9. 用户 A 的会话自然过期后，在另一标签页以用户 B 登录并打开同一乐谱；确认所有旧标签页立即停止显示或提交 A 的个人层、草稿、冲突与权限缓存。
10. 分别验证访客进入注册用户、同一用户多标签页和主动退出后的路径；确认工作区不互相提升，主动退出后仅保留只读共享离线内容。
11. 发布新版本后保留旧页面，确认出现明确更新提示，用户确认后才刷新。

真实 Safari、PWA 存储驱逐、手写笔和大陆网络表现不能由桌面自动化或 WebKit 模拟替代。
