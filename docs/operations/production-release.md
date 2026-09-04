# Production release runbook

本页把“代码通过”“已发布”“域名可达”“邮件可投递”和“实机验收”分开记录。任一项
通过都不能替代其余项目。

## 固定生产边界

- URL：`https://samepage.clyapps.com`
- Worker：`same-page`，关闭 `workers.dev` 与 preview URL
- D1：`same-page-production`（APAC）
- R2：`same-page-production-scores`（APAC、Standard）
- 邮件发件人：`Same Page <login@samepage.clyapps.com>`
- Resend 发信域：`samepage.clyapps.com`，与根域真人邮件/Webmail 信誉隔离
- Resend key：Same Page 独立、Sending access、只允许 `samepage.clyapps.com`
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
   `RESEND_API_KEY_SAMEPAGE`。需要启用第三方登录时，再设置完整的 `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET` 和 `WECHAT_CLIENT_ID` / `WECHAT_CLIENT_SECRET`；缺少任意一项时
   对应入口会保持隐藏。
4. 部署前先在 Resend 验证 `samepage.clyapps.com` 的 SPF、DKIM、DMARC 与 Return-Path，
   创建仅允许该子域的 Sending-only key，并先写入尚未被当前版本读取的 Worker
   `RESEND_API_KEY_SAMEPAGE`。代码部署时才切换到该 Secret，避免旧发件人与新密钥不匹配；
   旧 Secret 和旧 key 仅保留到真实投递验收完成，以便回滚。发信子域记录不得改动根域 MX、
   Cloudflare Email Routing 或 Webmail；不得在域未 verified 时切换 From。
5. 部署 Worker 与静态资源；Wrangler 的 custom domain 配置负责创建 DNS 记录和证书。
6. 在 GitHub `production` environment 中设置 `CLOUDFLARE_API_TOKEN` 与
   `CLOUDFLARE_ACCOUNT_ID`。
7. 运行 `npm run verify:deployment -- https://samepage.clyapps.com`。
8. 首位管理员完成 OTP 注册后，通过受控命令创建“小红花云盘”。自动化命令不显示
   初始邀请码；管理员登录后在「管理 → 邀请码」查看，并通过私密渠道交付。
9. 如需启用“公开体验”，使用 `--guest-admission open --preview-entry` 创建唯一的公开体验云盘；已有开放准入云盘必须通过受控 SQL 明确设置 `is_preview_entry = 1`，不得按名称自动匹配。

## 认证邮件发送边界

- 标准化邮箱共享 60 秒冷却与 3 次/15 分钟窗口；客户端身份共享 10 次/15 分钟窗口。
  三者都由 Worker 执行，`429` 必须带 `Retry-After`，刷新或多标签页不能绕过。
- 为避免通过限流差异探测用户是否存在，可投递地址与不可投递地址都消耗相同发送门槛；实际
  成功发送数只会小于或等于门槛。D1 只保存 HMAC 后的邮箱和客户端标识，不保存原值。
- 注册和密码重设共用上述门槛；新 OTP 发出后旧 OTP 失效，有效期 10 分钟，每个 OTP 最多
  尝试 3 次。
- 邮件主题不得包含 OTP；text/HTML 正文必须说明 `samepage.clyapps.com`、用途、10 分钟
  有效期和非本人操作处理方式，不使用远程图片、营销内容或站外链接。
- Resend `Delivered` 只表示收件服务器接受。发布证据必须把 provider 状态、实际 Inbox/Spam
  位置和延迟分开记录，且不得包含 OTP、完整收件地址、Message-ID 或密钥。

## 第三方登录配置

- Google 使用 Web application OAuth client，授权回调固定为
  `https://samepage.clyapps.com/api/auth/callback/google`，只申请 `openid`、`email`、
  `profile`。OAuth 品牌配置中的应用首页为 `https://samepage.clyapps.com/`，隐私政策为
  `https://samepage.clyapps.com/privacy`，Authorized domain 填根域 `clyapps.com`（不带协议、
  子域或路径），并通过 Google Search Console 验证域名所有权。上线前单独确认 consent
  screen、品牌信息、允许域名和测试/发布状态。
- 微信只使用开放平台“网站应用”扫码登录，授权回调为
  `https://samepage.clyapps.com/api/auth/callback/wechat`，scope 必须是 `snsapi_login`；
  公众号网页授权不能替代该资质和配置。
- Client ID 与 Client Secret 都以 Worker Secret 管理。不得把 Secret 放入 `wrangler.jsonc`、
  `.dev.vars.example` 的实际值、GitHub Issue、PR 或发布日志。
- 部署代码、平台审核通过、生产 Secret 完整、真实账号授权成功是四个独立门槛。只有最后一项
  通过后，才能把对应提供方记为生产可用。

### 第三方登录故障排查

排查只记录提供方、时间、HTTP 状态和非敏感错误类别；不得复制授权 URL、callback query、
authorization code、token、完整 profile 或 Secret。

| 症状 | 检查 |
| --- | --- |
| Google 或微信图标未出现 | 请求 `/api/auth/social-providers`，确认响应仍为 `no-store`；用 `wrangler secret list` 只核对对应 Client ID / Secret 的名称是否成对存在，不读取或打印值。缺一项时隐藏入口是预期行为。 |
| Google 报 redirect URI 不匹配 | 核对 Web application client 的精确回调是 `https://samepage.clyapps.com/api/auth/callback/google`，协议、域名、路径和尾部斜杠必须一致。 |
| Google 只允许测试用户或显示 consent 错误 | 核对 consent screen 的测试/发布状态、测试用户、品牌域名和已验证域名；平台未发布不能记为生产可用。 |
| 微信提示 AppID、scope 或回调域错误 | 确认使用已审核的开放平台“网站应用”，scope 为 `snsapi_login`，AppID 属于该应用，授权回调域为 `samepage.clyapps.com`；公众号网页授权配置不能替代。 |
| 提供方确认后回到登录页并提示失败 | 先确认 `/api/health` 和邮箱登录正常，再按时间查 Worker 的非敏感状态日志；不要在日志或 Issue 中粘贴 callback URL。state 失效或重复回调应安全返回登录页，不能绕过重试。 |
| 中国大陆网络下 Google 超时 | 记录网络、设备和时间，将 Google 判为该场景不可用；确认邮箱入口始终可见可用。不要通过放宽 OAuth 校验或增加代理回调规避。 |

后续 `main` 发布必须先通过 CI 的 lint、typecheck、客户端测试、Worker 测试、PWA 更新交接、加载性能、视觉浏览器测试、迁移测试和生产构建。本地对应 `npm run check:full`；先运行 `npm ci` 和 `npx playwright install chromium webkit`（Linux/CI 使用 `--with-deps`）。`npm run check` 不包含 PWA 更新交接及加载性能，不能称为与 CI 相同的完整集合。
deploy job 随后执行 D1 migrations、Wrangler deploy 与线上机器验证；迁移或验证失败时
workflow 失败，不能记为发布成功。

## 每次发布记录

在对应 Issue 或 PR 中分别记录：

| 门槛 | 可接受证据 |
| --- | --- |
| 代码 | commit、PR、`npm run check:full` 结果（与 CI verify 相同集合，不代表部署或实机验收） |
| CI | verify 与 deploy job 的 workflow URL 和结论 |
| Cloudflare | Worker deployment ID、D1 migration 状态、R2 绑定 |
| 生产 URL | HTTPS、应用壳、manifest、Service Worker、`/api/health`、未登录 401 |
| 第三方登录 | 提供方审核状态、回调配置、入口可见性、真实 Google/微信各一次成功与取消返回 |
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
11. 在乐谱 A、B 分别离线编辑并退出阅读器；恢复网络或把应用切回前台，不重新打开 A、B，确认两份待上传内容都到达云端。随后让 A 暂时不可用并重复，确认 A 的原 `opId` 与 payload 留在本机、B 仍可完成同步，且没有自动 pull 未打开乐谱的新批注。
12. 发布新版本后保留旧页面，确认出现明确更新提示，用户确认后才刷新。
13. 在认证首屏确认邮箱表单仍在上方；分别完成 Google 与微信登录，并各取消一次；确认成功后续接原访客云盘流程，取消后邮箱草稿和原入口上下文仍保留。

14. 在公开体验中分别使用 Google、邮箱登录，确认无需加入即可在个人层新增、修改、删除批注，重新打开仍可读回；另一用户、管理员与访客均不可读取该个人层，共享层仍按授权编辑。
15. 管理员打开「管理 → 邀请码」查看当前码，关闭重开仍可查看；旧码仅有校验值时补录原码并确认原码继续有效，主动轮换后确认旧码失效。

真实 Safari、PWA 存储驱逐、手写笔和大陆网络表现不能由桌面自动化或 WebKit 模拟替代。
